"""对镜 · 弱点墙与回环 API

四区流转（方案 3.2）：
    ai_candidate → observing → improving → archived

回环提供两个入口（方案 3.3）：默认对话式，保留表单入口。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status as http_status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import prompts
from app.ai.router import TASK_LOOP_DIALOG, complete
from app.config import settings
from app.db import get_session
from app.deps import get_current_user
from app.models import User, WeaknessCard, WeaknessLoop
from app.services import debate as debate_service
from app.services import loops as loop_service
from app.services.loops import Stats
from app.services.serializers import log_out, loop_out, weakness_out
from app.utils import local_today, now_utc, parse_date

router = APIRouter(prefix="/api/weaknesses", tags=["弱点墙"])
loops_router = APIRouter(prefix="/api/loops", tags=["回环"])

VALID_DOMAINS = {
    "work",
    "relationship",
    "emotion",
    "decision",
    "expression",
    "health",
    "other",
}
VALID_WEAKNESS_STATUS = {"ai_candidate", "observing", "improving", "archived"}
VALID_LOOP_STATUS = {"draft", "active", "needs_revision", "paused", "archived"}
VALID_RESULTS = {"hold", "break", "not_triggered"}
VALID_LOG_SOURCE = {"debate", "event_card", "manual"}


# ── 请求体 ────────────────────────────────────────────────────


class CreateWeaknessPayload(BaseModel):
    name: str = Field(..., max_length=120)
    description: str = Field("", max_length=2000)
    domains: list[str] = Field(default_factory=list)
    confidence: int = Field(3, ge=1, le=5)


class UpdateWeaknessPayload(BaseModel):
    name: str | None = Field(None, max_length=120)
    description: str | None = Field(None, max_length=2000)
    domains: list[str] | None = None
    confidence: int | None = Field(None, ge=1, le=5)
    status: str | None = None


class LoopPayload(BaseModel):
    """新建回环。mode=form 走表单，mode=dialog 走对话式。"""

    mode: str = Field("form", max_length=10)
    trigger_scene: str = Field("", max_length=2000)
    body_signal: str = Field("", max_length=2000)
    action_plan: str = Field("", max_length=2000)
    activate: bool = False
    linked_advantage_ids: list[int] = Field(default_factory=list)
    linked_principle_ids: list[int] = Field(default_factory=list)

    # 对话式专用
    step: str = Field("", max_length=10)
    content: str = Field("", max_length=2000)


class UpdateLoopPayload(BaseModel):
    trigger_scene: str | None = Field(None, max_length=2000)
    body_signal: str | None = Field(None, max_length=2000)
    action_plan: str | None = Field(None, max_length=2000)
    status: str | None = Field(None, max_length=20)
    linked_advantage_ids: list[int] | None = None
    linked_principle_ids: list[int] | None = None


class LogPayload(BaseModel):
    result: str = Field(..., max_length=20)
    note: str = Field("", max_length=2000)
    source: str = Field("manual", max_length=20)
    source_id: int | None = None
    date: str | None = None


# ── 弱点 ──────────────────────────────────────────────────────


async def _get_owned_card(session: AsyncSession, weakness_id: int, user: User) -> WeaknessCard:
    card = await session.get(WeaknessCard, weakness_id)
    if card is None or card.user_id != user.id:
        raise HTTPException(status_code=404, detail="弱点不存在")
    return card


@router.get("")
async def list_weaknesses(
    status: str | None = None,
    status_filter: str = "ai_candidate,observing,improving",
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """弱点墙四区。返回按状态分组的结构，前端直接渲染四个分区。"""
    stmt = select(WeaknessCard).where(WeaknessCard.user_id == user.id)
    # 同时接受 status 与 status_filter：
    # API.md 第 3 章把参数写作 status，早期实现用的是 status_filter，
    # 两个名字都放行，避免任何一侧静默失效（筛选参数写错不会报错，
    # 只会返回全部数据——这类缺陷在页面上极难发现）。
    wanted = [s.strip() for s in (status or status_filter).split(",") if s.strip()]
    if wanted:
        stmt = stmt.where(WeaknessCard.status.in_(wanted))

    rows = await session.execute(stmt.order_by(WeaknessCard.id.desc()).limit(300))
    cards = list(rows.scalars().all())

    ids = [c.id for c in cards]
    stats = await loop_service.weakness_stats(session, ids)
    drills = await loop_service.drill_counts(session, ids)
    plans = await loop_service.plan_counts(session, ids)
    trends = await loop_service.weakness_trends(session, ids)

    groups: dict[str, list] = {
        "ai_candidate": [],
        "observing": [],
        "improving": [],
        "archived": [],
    }

    for card in cards:
        st = stats.get(card.id, Stats())
        payload = weakness_out(
            card,
            trigger_count=st.trigger_count,
            hold_count=st.hold_count,
            hold_rate=st.rate,
            plan_count=plans.get(card.id, 0),
            drill_count=drills.get(card.id, 0),
            trend=trends.get(card.id),
        )
        groups.setdefault(card.status, []).append(payload)

    return {"groups": groups, "total": len(cards)}


@router.post("", status_code=http_status.HTTP_201_CREATED)
async def create_weakness(
    payload: CreateWeaknessPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="弱点名称不能为空")

    domains = [d for d in payload.domains if d in VALID_DOMAINS]
    if not domains:
        raise HTTPException(status_code=400, detail="请至少选择一个影响领域")

    card = WeaknessCard(
        user_id=user.id,
        name=name,
        description=payload.description.strip(),
        domains=domains,
        status="observing",
        confidence=payload.confidence,
        source="user",
    )
    session.add(card)
    await session.commit()
    await session.refresh(card)

    return {"weakness": await loop_service.weakness_payload(session, card)}


@router.get("/{weakness_id}")
async def get_weakness(
    weakness_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    card = await _get_owned_card(session, weakness_id, user)

    st = (await loop_service.weakness_stats(session, [card.id])).get(card.id, Stats())
    drills = (await loop_service.drill_counts(session, [card.id])).get(card.id, 0)
    plans = (await loop_service.plan_counts(session, [card.id])).get(card.id, 0)

    loops = await session.execute(
        select(WeaknessLoop)
        .where(WeaknessLoop.weakness_id == card.id)
        .order_by(WeaknessLoop.id.desc())
    )
    loop_rows = list(loops.scalars().all())
    loop_id_list = [lp.id for lp in loop_rows]
    loop_stats_map = await loop_service.loop_stats(session, loop_id_list)
    loop_trend_map = await loop_service.loop_trends(session, loop_id_list)
    weakness_trend_map = await loop_service.weakness_trends(session, [card.id])

    loop_payload = []
    for lp in loop_rows:
        lst = loop_stats_map.get(lp.id, Stats())
        advantages, principles = await loop_service.load_linked_assets(session, lp)
        loop_payload.append(
            loop_out(
                lp,
                weakness=card,
                trigger_count=lst.trigger_count,
                hold_count=lst.hold_count,
                hold_rate=lst.rate,
                advantages=advantages,
                principles=principles,
                trend=loop_trend_map.get(lp.id),
            )
        )

    return {
        "weakness": weakness_out(
            card,
            trigger_count=st.trigger_count,
            hold_count=st.hold_count,
            hold_rate=st.rate,
            plan_count=plans,
            drill_count=drills,
            trend=weakness_trend_map.get(card.id),
        ),
        "loops": loop_payload,
        "suggest_downgrade": loop_service.should_suggest_downgrade(st),
        "suggest_archive": loop_service.should_suggest_archive(st) and not loop_rows,
    }


@router.patch("/{weakness_id}")
async def update_weakness(
    weakness_id: int,
    payload: UpdateWeaknessPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    card = await _get_owned_card(session, weakness_id, user)

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="弱点名称不能为空")
        card.name = name
    if payload.description is not None:
        card.description = payload.description.strip()
    if payload.domains is not None:
        domains = [d for d in payload.domains if d in VALID_DOMAINS]
        if not domains:
            raise HTTPException(status_code=400, detail="请至少选择一个影响领域")
        card.domains = domains
    if payload.confidence is not None:
        card.confidence = payload.confidence
    if payload.status is not None:
        if payload.status not in VALID_WEAKNESS_STATUS:
            raise HTTPException(status_code=400, detail="状态取值不合法")
        # 状态流转走专门的归档/恢复接口，这里只允许四区内的手动调整
        if payload.status == "archived":
            raise HTTPException(status_code=400, detail="移入暂存请使用归档接口")
        card.status = payload.status

    await session.commit()
    await session.refresh(card)
    return {"weakness": await loop_service.weakness_payload(session, card)}


@router.post("/{weakness_id}/archive")
async def archive_weakness(
    weakness_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """拖垃圾桶 → archived，60 天倒计时，触发计数保留。"""
    card = await _get_owned_card(session, weakness_id, user)
    if card.status == "archived":
        raise HTTPException(status_code=409, detail="这个弱点已经在暂存区了")

    await loop_service.archive_weakness(session, card, reason="manual")
    await session.commit()
    await session.refresh(card)

    return {
        "weakness": await loop_service.weakness_payload(session, card),
        "note": f"已移入暂存，{settings.WEAKNESS_DELETE_DAYS} 天后自动删除",
    }


@router.post("/{weakness_id}/restore")
async def restore_weakness(
    weakness_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """拖回黑板 → observing，触发计数保留（不清零）。"""
    card = await _get_owned_card(session, weakness_id, user)
    if card.status != "archived":
        raise HTTPException(status_code=409, detail="这个弱点不在暂存区")

    await loop_service.restore_weakness(session, card)
    await session.commit()
    await session.refresh(card)
    return {"weakness": await loop_service.weakness_payload(session, card)}


# ── 回环创建 ──────────────────────────────────────────────────


@router.post("/{weakness_id}/loops", status_code=http_status.HTTP_201_CREATED)
async def create_loop(
    weakness_id: int,
    payload: LoopPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    card = await _get_owned_card(session, weakness_id, user)

    if payload.mode == "dialog":
        return await _dialog_step(session, card, payload)

    trigger_scene = payload.trigger_scene.strip()
    if not trigger_scene:
        raise HTTPException(status_code=400, detail="触发场景不能为空")

    loop = await loop_service.create_loop(
        session,
        weakness=card,
        trigger_scene=trigger_scene,
        body_signal=payload.body_signal,
        action_plan=payload.action_plan,
        activate=payload.activate,
        linked_advantage_ids=payload.linked_advantage_ids,
        linked_principle_ids=payload.linked_principle_ids,
    )
    await session.commit()
    await session.refresh(loop)

    advantages, principles = await loop_service.load_linked_assets(session, loop)
    return {
        "loop": loop_out(loop, weakness=card, advantages=advantages, principles=principles)
    }


async def _dialog_step(session: AsyncSession, card: WeaknessCard, payload: LoopPayload) -> dict:
    """对话式回环启动。

    四步：scene → signal → plan →（创建草稿）→ 用户确认启用。
    服务端保持无状态，每一步由客户端把已收集的内容带上来。
    """
    step = (payload.step or "scene").strip()
    content = payload.content.strip()

    if step == "scene":
        if not content:
            raise HTTPException(status_code=400, detail="请先描述当时发生了什么")
        question = await _ask_loop_question(card.name, "signal", {"scene": content})
        return {"step": "signal", "question": question, "trigger_scene": content}

    if step == "signal":
        if not payload.trigger_scene.strip():
            raise HTTPException(status_code=400, detail="缺少触发场景")
        question = await _ask_loop_question(
            card.name, "plan", {"scene": payload.trigger_scene, "signal": content}
        )
        return {
            "step": "plan",
            "question": question,
            "trigger_scene": payload.trigger_scene,
            "body_signal": content,
        }

    if step == "plan":
        if not payload.trigger_scene.strip():
            raise HTTPException(status_code=400, detail="缺少触发场景")
        if not content:
            raise HTTPException(status_code=400, detail="请描述你的应对预案")

        loop = await loop_service.create_loop(
            session,
            weakness=card,
            trigger_scene=payload.trigger_scene,
            body_signal=payload.body_signal,
            action_plan=content,
            activate=False,  # 先落草稿，等用户点「启用」
        )
        await session.commit()
        await session.refresh(loop)

        return {
            "step": "confirm",
            "loop": loop_out(loop, weakness=card),
            "confirm_question": "好，这就是你的预案。要现在启用吗？",
        }

    raise HTTPException(status_code=400, detail="未知的对话步骤")


async def _ask_loop_question(weakness_name: str, step: str, collected: dict) -> str:
    messages = prompts.build_loop_dialog_messages(weakness_name, step, collected)
    response = await complete(TASK_LOOP_DIALOG, messages, temperature=0.7, max_tokens=200)
    return response.text.strip() or "能再说得具体一点吗？"


# ── 回环 ──────────────────────────────────────────────────────


async def _get_owned_loop(session: AsyncSession, loop_id: int, user: User) -> tuple[WeaknessLoop, WeaknessCard]:
    loop = await session.get(WeaknessLoop, loop_id)
    if loop is None:
        raise HTTPException(status_code=404, detail="回环不存在")
    card = await session.get(WeaknessCard, loop.weakness_id)
    if card is None or card.user_id != user.id:
        raise HTTPException(status_code=404, detail="回环不存在")
    return loop, card


@loops_router.patch("/{loop_id}")
async def update_loop(
    loop_id: int,
    payload: UpdateLoopPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    loop, card = await _get_owned_loop(session, loop_id, user)

    if payload.trigger_scene is not None:
        value = payload.trigger_scene.strip()
        if not value:
            raise HTTPException(status_code=400, detail="触发场景不能为空")
        loop.trigger_scene = value
    if payload.body_signal is not None:
        loop.body_signal = payload.body_signal.strip()
    if payload.action_plan is not None:
        loop.action_plan = payload.action_plan.strip()
    if payload.status is not None:
        if payload.status not in VALID_LOOP_STATUS:
            raise HTTPException(status_code=400, detail="状态取值不合法")
        loop.status = payload.status
        # 启用回环时，弱点从「观察中」进入「改善中」
        if payload.status == "active" and card.status == "observing":
            card.status = "improving"
    if payload.linked_advantage_ids is not None:
        loop.linked_advantage_ids = list(payload.linked_advantage_ids)
    if payload.linked_principle_ids is not None:
        loop.linked_principle_ids = list(payload.linked_principle_ids)

    loop.updated_at = now_utc()
    await session.commit()
    await session.refresh(loop)

    st = (await loop_service.loop_stats(session, [loop.id])).get(loop.id, Stats())
    tr = (await loop_service.loop_trends(session, [loop.id])).get(loop.id)
    advantages, principles = await loop_service.load_linked_assets(session, loop)

    return {
        "loop": loop_out(
            loop,
            weakness=card,
            trigger_count=st.trigger_count,
            hold_count=st.hold_count,
            hold_rate=st.rate,
            advantages=advantages,
            principles=principles,
            trend=tr,
        )
    }


@loops_router.post("/{loop_id}/logs", status_code=http_status.HTTP_201_CREATED)
async def create_log(
    loop_id: int,
    payload: LogPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """写演练日志 —— 系统里唯一能改变经验数据的入口。

    副作用（方案 3.3）：
      · 撑住率 ≥ 80% 且触发 ≥ 5 → 返回降级建议（**不自动降级**）
      · result=break → 回环进入待修订，并给出替代动作
    """
    loop, card = await _get_owned_loop(session, loop_id, user)

    if payload.result not in VALID_RESULTS:
        raise HTTPException(status_code=400, detail="结果取值不合法")
    if payload.source not in VALID_LOG_SOURCE:
        raise HTTPException(status_code=400, detail="来源取值不合法")

    on_date = parse_date(payload.date) or local_today()
    if on_date > local_today():
        raise HTTPException(status_code=400, detail="不能记录未来的日期")

    log = await loop_service.record_log(
        session,
        loop=loop,
        user_id=user.id,
        result=payload.result,
        note=payload.note,
        source=payload.source,
        source_id=payload.source_id,
        on_date=on_date,
    )

    st = (await loop_service.loop_stats(session, [loop.id])).get(loop.id, Stats())
    tr = (await loop_service.loop_trends(session, [loop.id])).get(loop.id)
    await session.commit()
    await session.refresh(log)
    await session.refresh(loop)

    result: dict = {
        "log": log_out(log),
        "hold_rate_30d": st.rate,
        "trigger_count_30d": st.trigger_count,
        "loop_status": loop.status,
        "hold_rate_7d": tr.rate_7d if tr else None,
        "hold_rate_prev_7d": tr.rate_prev_7d if tr else None,
        "trend_delta": tr.delta if tr else None,
    }

    if loop_service.should_suggest_downgrade(st):
        result.update(loop_service.suggest_downgrade_payload(st))

    if payload.result == "break":
        alternative = await debate_service.generate_alternative_action(
            loop.trigger_scene, loop.action_plan, payload.note
        )
        result["alternative_action"] = alternative
        result["needs_revision"] = True

    return result


@loops_router.get("/{loop_id}/logs")
async def list_logs(
    loop_id: int,
    limit: int = 20,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    loop, _card = await _get_owned_loop(session, loop_id, user)
    logs = await loop_service.recent_logs(session, loop.id, limit=min(limit, 100))
    st = (await loop_service.loop_stats(session, [loop.id])).get(loop.id, Stats())
    tr = (await loop_service.loop_trends(session, [loop.id])).get(loop.id)

    return {
        "logs": [log_out(item) for item in logs],
        "hold_rate_30d": st.rate,
        "trigger_count_30d": st.trigger_count,
        "hold_count_30d": st.hold_count,
        "hold_rate_7d": tr.rate_7d if tr else None,
        "hold_rate_prev_7d": tr.rate_prev_7d if tr else None,
        "trend_delta": tr.delta if tr else None,
    }


@loops_router.get("")
async def list_loops(
    status: str | None = None,
    status_filter: str | None = None,
    weakness_id: int | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """全量回环列表。

    **为什么需要这个接口**：原则库要支持「一条原则关联多个回环」，
    而此前没有任何地方能一次拿到用户的全部回环——前端只能先拉弱点列表、
    再逐个拉弱点详情去凑（20 个弱点就是 21 次请求）。这是实打实的 N+1。

    统计一次性批量查询，避免按回环逐条聚合。
    """
    stmt = (
        select(WeaknessLoop, WeaknessCard)
        .join(WeaknessCard, WeaknessLoop.weakness_id == WeaknessCard.id)
        .where(WeaknessCard.user_id == user.id)
    )

    if weakness_id is not None:
        stmt = stmt.where(WeaknessLoop.weakness_id == weakness_id)

    raw_status = status or status_filter
    if raw_status:
        wanted = [s.strip() for s in raw_status.split(",") if s.strip()]
        if wanted:
            stmt = stmt.where(WeaknessLoop.status.in_(wanted))

    rows = (await session.execute(stmt.order_by(WeaknessLoop.id.desc()).limit(300))).all()
    if not rows:
        return {"loops": [], "total": 0}

    loop_id_list = [lp.id for lp, _ in rows]
    stats_map = await loop_service.loop_stats(session, loop_id_list)
    trend_map = await loop_service.loop_trends(session, loop_id_list)

    payload = []
    for loop, card in rows:
        st = stats_map.get(loop.id, Stats())
        payload.append(
            loop_out(
                loop,
                weakness=card,
                trigger_count=st.trigger_count,
                hold_count=st.hold_count,
                hold_rate=st.rate,
                trend=trend_map.get(loop.id),
            )
        )

    return {"loops": payload, "total": len(payload)}
