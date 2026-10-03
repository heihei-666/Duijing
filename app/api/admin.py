"""对镜 · 管理接口

目前只有 AI 观测。**这是把「我用了前缀缓存」变成「命中率 X%、省了 Y 元」
的那个出口** —— 在此之前，那些数字只能人工去服务商后台看，系统里没有。

访问控制：`require_admin`。第一个注册的用户自动是管理员（见 `api/auth.py`
的引导逻辑），所以单实例自用场景不会出现「没人能管」。

为什么要管理员而不是「看自己的」：成本、路由、失败率是**运行层面**的指标，
按用户切分既看不出路由对不对，也让这个接口的用途退化成个人账单。
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import require_admin
from app.models import AICallLog, User
from app.services import ai_metrics
from app.utils import iso_utc, now_utc

router = APIRouter(prefix="/api/admin", tags=["管理"])


@router.get("/ai-stats")
async def ai_stats(
    days: int = Query(7, ge=1, le=90, description="统计窗口（天）"),
    recent: int = Query(20, ge=0, le=200, description="返回最近多少条明细"),
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    """AI 调用统计：用量、成本、缓存命中率、延迟、路由分布、失败率。

    **价格表会一起返回**（`prices` 字段）—— 成本数字必须能被复核，
    否则它就是一个来路不明的传说。改价要同时改 `app/services/ai_metrics.py`。
    """
    since = now_utc() - timedelta(days=days)

    # 按 provider 分组：路由对不对、两家的花费差多少，都在这张表里
    grouped = await session.execute(
        select(
            AICallLog.provider,
            func.count(AICallLog.id),
            func.sum(AICallLog.prompt_tokens),
            func.sum(AICallLog.completion_tokens),
            func.sum(AICallLog.cached_tokens),
            func.sum(AICallLog.latency_ms),
        )
        .where(AICallLog.created_at >= since)
        .group_by(AICallLog.provider)
    )

    by_provider = []
    total_cost = 0.0
    total_calls = 0
    total_prompt = 0
    total_cached = 0
    total_completion = 0

    for provider, calls, prompt, completion, cached, latency in grouped.all():
        prompt = int(prompt or 0)
        completion = int(completion or 0)
        cached = int(cached or 0)
        calls = int(calls or 0)
        cost = ai_metrics.estimate_cost(
            provider,
            prompt_tokens=prompt,
            cached_tokens=cached,
            completion_tokens=completion,
        )
        total_cost += cost
        total_calls += calls
        total_prompt += prompt
        total_cached += cached
        total_completion += completion
        by_provider.append(
            {
                "provider": provider,
                "calls": calls,
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached,
                "cache_hit_rate": round(cached / prompt, 4) if prompt else None,
                "avg_latency_ms": int(latency / calls) if calls and latency else None,
                "cost_yuan": round(cost, 6),
            }
        )

    by_provider.sort(key=lambda row: row["calls"], reverse=True)

    # 按 task 分组：哪一类任务最贵、最慢
    task_rows = await session.execute(
        select(
            AICallLog.task,
            func.count(AICallLog.id),
            func.sum(AICallLog.prompt_tokens + AICallLog.completion_tokens),
            func.avg(AICallLog.latency_ms),
        )
        .where(AICallLog.created_at >= since)
        .group_by(AICallLog.task)
        .order_by(func.count(AICallLog.id).desc())
    )
    by_task = [
        {
            "task": task,
            "calls": int(calls or 0),
            "tokens": int(tokens or 0),
            "avg_latency_ms": int(avg_latency) if avg_latency is not None else None,
        }
        for task, calls, tokens, avg_latency in task_rows.all()
    ]

    errors = await session.scalar(
        select(func.count(AICallLog.id)).where(
            AICallLog.created_at >= since, AICallLog.status != "ok"
        )
    )
    errors = int(errors or 0)

    # TTFT 只对流式调用有意义（一个字的延迟 vs 一整段的总时长）
    ttft_row = await session.execute(
        select(func.avg(AICallLog.ttft_ms), func.count(AICallLog.ttft_ms)).where(
            AICallLog.created_at >= since, AICallLog.ttft_ms.is_not(None)
        )
    )
    avg_ttft, ttft_count = ttft_row.one()

    recent_calls = []
    if recent:
        rows = await session.execute(
            select(AICallLog)
            .where(AICallLog.created_at >= since)
            .order_by(AICallLog.id.desc())
            .limit(recent)
        )
        recent_calls = [
            {
                "id": row.id,
                "created_at": iso_utc(row.created_at),
                "task": row.task,
                "provider": row.provider,
                "model": row.model,
                "prompt_version": row.prompt_version,
                "prompt_tokens": row.prompt_tokens,
                "completion_tokens": row.completion_tokens,
                "cached_tokens": row.cached_tokens,
                "latency_ms": row.latency_ms,
                "ttft_ms": row.ttft_ms,
                "status": row.status,
                "streamed": row.streamed,
                "error": row.error,
            }
            for row in rows.scalars().all()
        ]

    return {
        "window_days": days,
        "since": iso_utc(since),
        "totals": {
            "calls": total_calls,
            "errors": errors,
            "error_rate": round(errors / total_calls, 4) if total_calls else None,
            "prompt_tokens": total_prompt,
            "completion_tokens": total_completion,
            "cached_tokens": total_cached,
            # 这个数字就是「前缀缓存到底有没有生效」的答案
            "cache_hit_rate": round(total_cached / total_prompt, 4) if total_prompt else None,
            "cost_yuan": round(total_cost, 6),
            "avg_ttft_ms": int(avg_ttft) if avg_ttft is not None else None,
            "ttft_samples": int(ttft_count or 0),
        },
        "by_provider": by_provider,
        "by_task": by_task,
        "recent_calls": recent_calls,
        # 进程内计数（含尚未落库的缓冲），用于实时观察
        "live": ai_metrics.snapshot(),
        # 价格表随响应返回，保证成本数字可复核
        "prices": ai_metrics.PRICES,
        "prices_unit": "元 / 百万 token",
    }
