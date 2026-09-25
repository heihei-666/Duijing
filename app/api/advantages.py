"""对镜 · 优势库 API

方案 3.5：AI 观察后自动入库并标记「待确认」，不弹窗、不打断、不强制。
所以这里**没有**「新增优势」接口——用户不手写优势，只做确认/移除。
移除会留痕（status=removed），AI 不再重复入库同一标签。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import Advantage, User
from app.services.serializers import advantage_out
from app.utils import now_utc

router = APIRouter(prefix="/api/advantages", tags=["优势库"])


async def _get_owned(session: AsyncSession, advantage_id: int, user: User) -> Advantage:
    adv = await session.get(Advantage, advantage_id)
    if adv is None or adv.user_id != user.id:
        raise HTTPException(status_code=404, detail="优势不存在")
    return adv


@router.get("")
async def list_advantages(
    status: str | None = None,
    status_filter: str = "pending,confirmed",
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Advantage).where(Advantage.user_id == user.id)
    # 同时接受 status 与 status_filter：
    # API.md 第 3 章把参数写作 status，早期实现用的是 status_filter，
    # 两个名字都放行，避免任何一侧静默失效（筛选参数写错不会报错，
    # 只会返回全部数据——这类缺陷在页面上极难发现）。
    wanted = [s.strip() for s in (status or status_filter).split(",") if s.strip()]
    if wanted:
        stmt = stmt.where(Advantage.status.in_(wanted))

    rows = await session.execute(stmt.order_by(Advantage.id.desc()).limit(200))
    items = list(rows.scalars().all())

    return {
        "advantages": [advantage_out(a) for a in items],
        "total": len(items),
        "pending_count": sum(1 for a in items if a.status == "pending"),
    }


@router.post("/{advantage_id}/confirm")
async def confirm_advantage(
    advantage_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """确认优势。只有已确认的优势才在回环预案中被推荐。"""
    adv = await _get_owned(session, advantage_id, user)
    adv.verified = True
    adv.status = "confirmed"
    await session.commit()
    return {"advantage": advantage_out(adv)}


@router.post("/{advantage_id}/remove")
async def remove_advantage(
    advantage_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """移除。

    不物理删除——留一条 status=removed 的记录，
    这样 AI 不会把同一个标签反复塞回来（方案 3.5）。
    """
    adv = await _get_owned(session, advantage_id, user)
    adv.status = "removed"
    adv.verified = False
    await session.commit()
    return {"ok": True, "note": "已移除，AI 不会再重复入库这个标签"}


@router.post("/{advantage_id}/restore")
async def restore_advantage(
    advantage_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    adv = await _get_owned(session, advantage_id, user)
    if adv.status == "archived":
        adv.status = "pending"
        adv.archived_at = None
    elif adv.status == "removed":
        adv.status = "pending"
    else:
        raise HTTPException(status_code=409, detail="这条优势当前无需恢复")
    adv.verified = False
    await session.commit()
    return {"advantage": advantage_out(adv)}


async def archive_stale(session: AsyncSession, days: int) -> int:
    """待确认超 N 天自动归档（方案 3.5，默认 30 天）。定时任务调用。"""
    from datetime import timedelta

    cutoff = now_utc() - timedelta(days=days)
    rows = await session.execute(
        select(Advantage).where(
            Advantage.status == "pending",
            Advantage.created_at <= cutoff,
        )
    )
    items = list(rows.scalars().all())
    for adv in items:
        adv.status = "archived"
        adv.archived_at = now_utc()
    await session.flush()
    return len(items)
