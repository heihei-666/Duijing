"""对镜 · AI 观察 API

24 小时倒计时从「首次看到」起算，这个副作用发生在 list_pending 里。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import AIObservation, User
from app.services import observations as observation_service
from app.services.serializers import observation_out

router = APIRouter(prefix="/api/observations", tags=["AI 观察"])


async def _get_owned(session: AsyncSession, obs_id: int, user: User) -> AIObservation:
    obs = await session.get(AIObservation, obs_id)
    if obs is None or obs.user_id != user.id:
        raise HTTPException(status_code=404, detail="观察记录不存在")
    return obs


@router.get("")
async def list_observations(
    status: str | None = None,
    status_filter: str = "pending",
    limit: int = 50,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # 同时接受 status 与 status_filter：
    # API.md 第 3 章把参数写作 status，早期实现用的是 status_filter，
    # 两个名字都放行，避免任何一侧静默失效（筛选参数写错不会报错，
    # 只会返回全部数据——这类缺陷在页面上极难发现）。
    raw_status = status or status_filter

    if raw_status == "pending":
        items = await observation_service.list_pending(session, user.id, limit=limit)
        await session.commit()  # 落 first_seen_at
    else:
        wanted = [s.strip() for s in raw_status.split(",") if s.strip()]
        rows = await session.execute(
            select(AIObservation)
            .where(
                AIObservation.user_id == user.id,
                AIObservation.status.in_(wanted),
            )
            .order_by(AIObservation.created_at.desc())
            .limit(limit)
        )
        items = list(rows.scalars().all())

    return {"observations": [observation_out(o) for o in items], "total": len(items)}


@router.post("/{obs_id}/accept")
async def accept_observation(
    obs_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """加入 → 建弱点卡，或优势入库（待确认）。"""
    obs = await _get_owned(session, obs_id, user)
    if obs.status != "pending":
        raise HTTPException(status_code=409, detail="这条观察已经处理过了")

    kind, created_id = await observation_service.accept(session, obs, user)
    await session.commit()
    return {"created": {"kind": kind, "id": created_id}}


@router.post("/{obs_id}/ignore")
async def ignore_observation(
    obs_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    obs = await _get_owned(session, obs_id, user)
    if obs.status != "pending":
        raise HTTPException(status_code=409, detail="这条观察已经处理过了")

    await observation_service.ignore(session, obs)
    await session.commit()
    return {"ok": True}
