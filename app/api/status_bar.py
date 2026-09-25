"""对镜 · 状态栏 API（首页）

方案第九章第 6 条：状态栏只做轻操作——
不能写日记、建原则、开辩论。所以这里只有读 + 写精力的接口。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import DailyState, User
from app.services import status as status_service
from app.utils import local_today

router = APIRouter(prefix="/api", tags=["状态栏"])

VALID_MOODS = {"great", "good", "calm", "low", "bad"}


class DailyStatePayload(BaseModel):
    energy: int | None = Field(None, ge=0, le=100)
    mood: str | None = Field(None, max_length=16)


@router.get("/status-bar")
async def get_status_bar(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    payload = await status_service.build_status_bar(session, user)
    await session.commit()  # 首次看到 AI 观察候选时要落 first_seen_at
    return payload


@router.post("/daily-state")
async def upsert_daily_state(
    payload: DailyStatePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if payload.energy is None and payload.mood is None:
        raise HTTPException(status_code=400, detail="请至少填写精力和心情中的一项")

    if payload.mood is not None and payload.mood not in VALID_MOODS:
        raise HTTPException(status_code=400, detail="心情取值不合法")

    today = local_today()
    state = await session.scalar(
        select_state(user.id, today)
    )
    if state is None:
        state = DailyState(user_id=user.id, date=today)
        session.add(state)

    # 允许只更新其中一项，另一项保持原值（方案 3.7：可跳过，不填不显示）
    if payload.energy is not None:
        state.energy = payload.energy
    if payload.mood is not None:
        state.mood = payload.mood

    await session.commit()
    await session.refresh(state)

    return {"date": state.date.isoformat(), "energy": state.energy, "mood": state.mood}


def select_state(user_id: int, target):
    from sqlalchemy import select

    return select(DailyState).where(
        DailyState.user_id == user_id, DailyState.date == target
    )
