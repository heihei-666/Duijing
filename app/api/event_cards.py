"""对镜 · 事件卡 API

方案 3.4：入口在首页 + 「记一笔」。
记录方式支持完整模式和极简模式，极简模式只写一句。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status as http_status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import EventCard, User, WeaknessCard, WeaknessLoop
from app.services import event_cards as event_card_service
from app.services import loops as loop_service
from app.services.ratelimit import ai_limiter, enforce
from app.config import settings
from app.services.serializers import event_card_out, log_out

router = APIRouter(prefix="/api/event-cards", tags=["事件卡"])

VALID_RESULTS = {"hold", "break", "not_triggered", "unsure"}


class CreateEventCardPayload(BaseModel):
    content: str = Field(..., max_length=1000)
    linked_loop_ids: list[int] = Field(default_factory=list)
    result: str | None = Field(None, max_length=20)


async def _owned_loops(
    session: AsyncSession, user: User, loop_ids: list[int]
) -> list[WeaknessLoop]:
    if not loop_ids:
        return []
    rows = await session.execute(
        select(WeaknessLoop)
        .join(WeaknessCard, WeaknessLoop.weakness_id == WeaknessCard.id)
        .where(WeaknessLoop.id.in_(loop_ids), WeaknessCard.user_id == user.id)
    )
    loops = list(rows.scalars().all())
    if len(loops) != len(set(loop_ids)):
        raise HTTPException(status_code=400, detail="存在无效的回环")
    return loops


@router.get("")
async def list_event_cards(
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """事件卡永久保留，这里只分页，不过滤。"""
    rows = await session.execute(
        select(EventCard)
        .where(EventCard.user_id == user.id)
        .order_by(EventCard.id.desc())
        .limit(min(limit, 200))
        .offset(max(offset, 0))
    )
    cards = list(rows.scalars().all())

    loop_ids = {lid for card in cards for lid in (card.linked_loop_ids or [])}
    loop_map: dict[int, WeaknessLoop] = {}
    if loop_ids:
        loop_rows = await session.execute(
            select(WeaknessLoop).where(WeaknessLoop.id.in_(loop_ids))
        )
        loop_map = {lp.id: lp for lp in loop_rows.scalars().all()}

    return {
        "cards": [
            event_card_out(card, loops=[loop_map[i] for i in (card.linked_loop_ids or []) if i in loop_map])
            for card in cards
        ],
        "total": len(cards),
    }


@router.post("", status_code=http_status.HTTP_201_CREATED)
async def create_event_card(
    payload: CreateEventCardPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="请至少写一句发生了什么")

    result = (payload.result or "").strip() or None
    if result is not None and result not in VALID_RESULTS:
        raise HTTPException(status_code=400, detail="结果取值不合法")

    card = EventCard(user_id=user.id, content=content, result=result)
    session.add(card)
    await session.flush()

    created_logs = []
    auto_linked = False

    if payload.linked_loop_ids and result in ("hold", "break", "not_triggered"):
        # 完整模式：立即写 loop_log
        loops = await _owned_loops(session, user, payload.linked_loop_ids)
        card.linked_loop_ids = [lp.id for lp in loops]
        card.analyzed = True
        card.pending_confirm = False

        for loop in loops:
            log = await loop_service.record_log(
                session,
                loop=loop,
                user_id=user.id,
                result=result,
                note=content[:200],
                source="event_card",
                source_id=card.id,
            )
            created_logs.append(log)
        auto_linked = True

    else:
        # 极简模式：先给一个零成本的本地关联建议，真正的 AI 判定进队列
        suggestions = await event_card_service.suggest_loops(session, user.id, content)
        if suggestions:
            card.linked_loop_ids = [lp.id for lp in suggestions[:1]]
            auto_linked = True

        if result is None:
            card.pending_confirm = True

        await event_card_service.enqueue(
            session,
            user_id=user.id,
            task_type="analyze_event_card",
            payload={"card_id": card.id},
        )

    await session.commit()
    await session.refresh(card)

    loop_map = {}
    if card.linked_loop_ids:
        rows = await session.execute(
            select(WeaknessLoop).where(WeaknessLoop.id.in_(card.linked_loop_ids))
        )
        loop_map = {lp.id: lp for lp in rows.scalars().all()}

    return {
        "card": event_card_out(
            card, loops=[loop_map[i] for i in card.linked_loop_ids if i in loop_map]
        ),
        "auto_linked": auto_linked,
        "pending_confirm": card.pending_confirm,
        "created_logs": [log_out(item) for item in created_logs],
    }


@router.post("/analyze")
async def analyze_now(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """手动触发扫描。

    方案 3.4 保留了「分析最近事件卡」手动按钮——
    默认是每周日夜间自动跑，但用户想立刻看结果时不该等到周日。
    """
    enforce(ai_limiter, f"event-scan:{user.id}", settings.AI_RATE_PER_MIN, "操作过于频繁")

    analyzed = await event_card_service.analyze_pending(session, user.id)
    scanned = await event_card_service.scan_recent_cards(session, user.id)
    await session.commit()

    return {
        "scanned": scanned.get("scanned", 0),
        "cards_analyzed": analyzed.get("processed", 0),
        "pending_confirm": analyzed.get("pending_confirm", 0),
        "candidates": [
            {"id": obs.id, "type": obs.type, "content": obs.content}
            for obs in scanned.get("candidates", [])
        ],
    }
