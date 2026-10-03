"""对镜 · 事件卡服务

方案 3.4 + 5.4 之间存在一处张力，这里的处理方式需要说明：

    3.4 说：极简模式「保存后 AI 自动判断关联和结果」
    5.4 说：事件卡不实时扫描，进队列，每周日 02:00 批量处理

两者兼顾的做法：
  · 保存时立刻做一次**零成本的本地匹配**（字符重合度），给用户一个即时关联建议
  · 真正的 AI 判定进 ai_queue，夜间批处理，或由用户点「分析最近事件卡」即时触发
  · AI 没把握时，卡片标记 pending_confirm，前端显示「待确认」

这样既不违背错峰策略，也不会让用户存完一句话后界面毫无反应。
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import prompts
from app.ai.router import TASK_CANDIDATE, TASK_EVENT_SCAN
from app.ai.structured import EventCardAnalysis, ScanCandidates, complete_json
from app.models import (
    AIQueue,
    EventCard,
    LoopStatus,
    User,
    WeaknessCard,
    WeaknessLoop,
)
from app.services import observations as observation_service
from app.services import loops as loop_service
from app.utils import local_day_start_utc, local_today, now_utc

logger = logging.getLogger("duijing.event_cards")

# 本地匹配的相似度阈值：低于它就不要硬关联，避免污染 loop_log
MATCH_THRESHOLD = 0.34
SCAN_WINDOW_DAYS = 7


# ─────────────────────────────────────────────────────────────
# 零成本本地匹配
# ─────────────────────────────────────────────────────────────


def _bigrams(text: str) -> set[str]:
    cleaned = "".join(ch for ch in (text or "") if ch.strip())
    if len(cleaned) < 2:
        return {cleaned} if cleaned else set()
    return {cleaned[i : i + 2] for i in range(len(cleaned) - 1)}


def similarity(a: str, b: str) -> float:
    """字符二元组重合度。中文短句上比编辑距离更稳，且完全不需要模型。"""
    set_a, set_b = _bigrams(a), _bigrams(b)
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


async def suggest_loops(
    session: AsyncSession, user_id: int, content: str, *, limit: int = 3
) -> list[WeaknessLoop]:
    """本地找出最相关的回环，按相似度降序。"""
    rows = await session.execute(
        select(WeaknessLoop)
        .join(WeaknessCard, WeaknessLoop.weakness_id == WeaknessCard.id)
        .where(
            WeaknessCard.user_id == user_id,
            WeaknessLoop.status == LoopStatus.ACTIVE.value,
        )
    )
    candidates = list(rows.scalars().all())
    if not candidates:
        return []

    scored = []
    for loop in candidates:
        score = max(
            similarity(content, loop.trigger_scene),
            similarity(content, loop.action_plan or ""),
        )
        if score >= MATCH_THRESHOLD:
            scored.append((score, loop))

    scored.sort(key=lambda item: (-item[0], item[1].id))
    return [loop for _score, loop in scored[:limit]]


# ─────────────────────────────────────────────────────────────
# 队列
# ─────────────────────────────────────────────────────────────


async def enqueue(session: AsyncSession, *, user_id: int, task_type: str, payload: dict) -> AIQueue:
    """把一条 AI 任务放进延迟队列。

    会校验任务类型：没有注册处理器的类型进了队也只能在夜里被判为
    「未知任务类型」然后失败，不如在**入队那一刻**就报出来。
    """
    from app.services.ai_queue import KNOWN_TASKS

    if task_type not in KNOWN_TASKS:
        raise ValueError(
            f"未注册的任务类型 {task_type!r}；"
            f"新增类型时要在 app/services/ai_queue.py 的 HANDLERS 里注册"
        )

    task = AIQueue(user_id=user_id, task_type=task_type, payload_json=payload or {})
    session.add(task)
    await session.flush()
    return task


async def pending_cards(session: AsyncSession, user_id: int) -> list[EventCard]:
    rows = await session.execute(
        select(EventCard)
        .where(EventCard.user_id == user_id, EventCard.analyzed.is_(False))
        .order_by(EventCard.id.asc())
        .limit(100)
    )
    return list(rows.scalars().all())


# ─────────────────────────────────────────────────────────────
# AI 判定（单卡）
# ─────────────────────────────────────────────────────────────


async def analyze_card(session: AsyncSession, card: EventCard) -> dict:
    """用 AI 判定单张事件卡的关联回环与结果。"""
    loop_rows = await session.execute(
        select(WeaknessLoop)
        .join(WeaknessCard, WeaknessLoop.weakness_id == WeaknessCard.id)
        .where(
            WeaknessCard.user_id == card.user_id,
            WeaknessLoop.status == LoopStatus.ACTIVE.value,
        )
        .order_by(WeaknessLoop.id.asc())
    )
    loops = list(loop_rows.scalars().all())

    weakness_rows = await session.execute(
        select(WeaknessCard)
        .where(WeaknessCard.user_id == card.user_id)
        .order_by(WeaknessCard.id.asc())
    )
    weaknesses = list(weakness_rows.scalars().all())

    if not loops:
        card.analyzed = True
        card.pending_confirm = False
        return {"linked": [], "result": card.result or "not_triggered", "reason": "没有启用中的回环"}

    messages = prompts.build_event_card_analysis_messages(card.content, loops, weaknesses)
    parsed, _response = await complete_json(
        TASK_EVENT_SCAN, messages, EventCardAnalysis, temperature=0.3, max_tokens=300
    )

    if parsed is None:
        # 两次都拿不到合法输出 → 标记待确认，让用户自己看一眼。
        # 这里**不猜**结果：方案 3.4 要求「不确定时标记待确认」，
        # 瞎猜一个 hold/break 会直接写进撑住率，污染的是用户最核心的数据。
        card.analyzed = True
        card.pending_confirm = True
        return {
            "linked": [],
            "result": "unsure",
            "pending_confirm": True,
            "reason": "AI 输出不合法，待用户确认",
        }

    valid_ids = {loop.id for loop in loops}
    linked: list[int] = [parsed.loop_id] if parsed.loop_id in valid_ids else []
    # schema 里 result 是 Literal，所以这里拿到的必定是四个合法取值之一
    result = parsed.result

    card.analyzed = True

    if not linked or result == "unsure":
        # AI 没把握 → 标记待确认，等用户自己看一眼
        card.pending_confirm = True
        if linked:
            card.linked_loop_ids = linked
        if result != "unsure":
            card.result = result
        return {"linked": linked, "result": result, "pending_confirm": True}

    card.pending_confirm = False
    card.linked_loop_ids = linked
    card.result = result

    # 判定成功才写 loop_log —— 这是唯一改变经验数据的路径
    for loop_id in linked:
        loop = await session.get(WeaknessLoop, loop_id)
        if loop is None:
            continue
        log_source = "event_card"
        await loop_service.record_log(
            session,
            loop=loop,
            user_id=card.user_id,
            result=result,
            note=card.content[:200],
            source=log_source,
            source_id=card.id,
        )

    return {"linked": linked, "result": result, "pending_confirm": False}


async def analyze_pending(session: AsyncSession, user_id: int, *, limit: int = 20) -> dict:
    """处理该用户所有未分析的事件卡。"""
    cards = await pending_cards(session, user_id)
    processed = 0
    pending_confirm = 0

    for card in cards[:limit]:
        try:
            outcome = await analyze_card(session, card)
            processed += 1
            if outcome.get("pending_confirm"):
                pending_confirm += 1
        except Exception:  # noqa: BLE001 - 单卡失败不能拖垮整批
            logger.exception("事件卡分析失败 card=%s", card.id)
    await session.flush()

    return {"processed": processed, "pending_confirm": pending_confirm}


# ─────────────────────────────────────────────────────────────
# 批量扫描 → 弱点候选
# ─────────────────────────────────────────────────────────────


async def scan_recent_cards(session: AsyncSession, user_id: int, *, days: int = SCAN_WINDOW_DAYS) -> dict:
    """扫描最近 N 天事件卡，生成弱点候选（方案 3.4）。"""
    since = local_day_start_utc(local_today() - timedelta(days=days - 1))

    rows = await session.execute(
        select(EventCard)
        .where(EventCard.user_id == user_id, EventCard.created_at >= since)
        .order_by(EventCard.id.asc())
    )
    cards = list(rows.scalars().all())
    if len(cards) < 3:
        return {"scanned": len(cards), "candidates": []}

    weakness_rows = await session.execute(
        select(WeaknessCard)
        .where(WeaknessCard.user_id == user_id)
        .order_by(WeaknessCard.id.asc())
    )
    weaknesses = list(weakness_rows.scalars().all())

    cards_text = "\n".join(f"- {card.content}" for card in cards)
    messages = prompts.build_event_scan_messages(cards_text, weaknesses)
    parsed, _response = await complete_json(
        TASK_CANDIDATE, messages, ScanCandidates, temperature=0.4, max_tokens=600
    )
    # 解析不出来就是「这次没扫到候选」，不是错误 —— 夜间批处理不该因为
    # 一次模型输出不规范就整批失败。失败率由 ai_metrics 的 json_success_rate 暴露。
    raw_candidates = parsed.candidates if parsed else []

    # 已经存在的弱点名称不再重复提出
    existing_names = {card.name.strip() for card in weaknesses}
    # 已经推送过且被忽略/已处理的候选也不重复推
    seen_rows = await session.execute(
        select(observation_service.AIObservation.content).where(
            observation_service.AIObservation.user_id == user_id
        )
    )
    seen_names = {row[0].strip() for row in seen_rows.all()}

    created = []
    for item in raw_candidates[:3]:
        name = item.name.strip()
        if not name or name in existing_names or name in seen_names:
            continue
        obs = await observation_service.create_observation(
            session,
            user_id=user_id,
            obs_type="weakness",
            content=name,
            source_type="scan",
        )
        created.append(obs)
        seen_names.add(name)

    await session.flush()
    return {"scanned": len(cards), "candidates": created}


async def run_weekly_scan(session: AsyncSession) -> dict:
    """每周日夜间批处理：分析待处理事件卡 + 生成弱点候选。"""
    user_rows = await session.execute(select(User.id))
    user_ids = [row[0] for row in user_rows.all()]

    total_cards = 0
    total_candidates = 0

    for user_id in user_ids:
        try:
            analyzed = await analyze_pending(session, user_id)
            total_cards += analyzed.get("processed", 0)

            scanned = await scan_recent_cards(session, user_id)
            total_candidates += len(scanned.get("candidates", []))
        except Exception:  # noqa: BLE001
            logger.exception("周扫描失败 user=%s", user_id)

    # ⚠️ 这里曾经有一段「把队列里所有 pending 无条件标成 done」的代码。
    # 那是假队列的收尾动作：任务被标记为完成，但**从来没有被执行过**。
    # 真正的消费者是 app/services/ai_queue.py，由调度器
    # job_process_ai_queue 在每天 02:30 推进（方案 5.4：后台任务全部夜间执行）。
    await session.flush()
    return {"users": len(user_ids), "cards_analyzed": total_cards, "candidates": total_candidates}
