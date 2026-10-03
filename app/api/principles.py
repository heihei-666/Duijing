"""对镜 · 原则库 API

方案 3.6 的规则：
  · 候选不消失，不设 24 小时限制
  · 忽略留痕，AI 不再重复推同一原则
  · 一条原则可关联多个回环
  · 归档可恢复
  · 不进状态栏
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import Principle, User, WeaknessCard, WeaknessLoop
from app.services.serializers import principle_out
from app.utils import now_utc

router = APIRouter(prefix="/api/principles", tags=["原则库"])

VALID_CONFIDENCE = {"high", "medium", "low"}


class CreatePrinciplePayload(BaseModel):
    content: str = Field(..., max_length=200)
    confidence: str = Field("medium", max_length=16)
    linked_loop_ids: list[int] = Field(default_factory=list)


class UpdatePrinciplePayload(BaseModel):
    content: str | None = Field(None, max_length=200)
    pinned: bool | None = None
    linked_loop_ids: list[int] | None = None


async def _get_owned(session: AsyncSession, principle_id: int, user: User) -> Principle:
    principle = await session.get(Principle, principle_id)
    if principle is None or principle.user_id != user.id:
        raise HTTPException(status_code=404, detail="原则不存在")
    return principle


async def _linked_loops(session: AsyncSession, principle: Principle) -> list[WeaknessLoop]:
    """取这条原则关联的回环。

    **必须再过一次归属**：`linked_loop_ids` 是库里的裸 ID 列表，
    只按 id 查的话，把别人的回环 ID 写进自己的原则就能读到它。
    归属从原则自己身上取（原则已通过 `_get_owned` 校验），所以调用方不用改。
    """
    ids = list(principle.linked_loop_ids or [])
    if not ids:
        return []
    rows = await session.execute(
        select(WeaknessLoop)
        .join(WeaknessCard, WeaknessCard.id == WeaknessLoop.weakness_id)
        .where(WeaknessLoop.id.in_(ids), WeaknessCard.user_id == principle.user_id)
    )
    return list(rows.scalars().all())


async def _owned_loop_ids(session: AsyncSession, ids: list[int] | None, user_id: int) -> list[int]:
    """写入前过滤：只保留确实属于该用户的回环 ID（保持顺序、去重）。"""
    wanted = [int(i) for i in (ids or [])]
    if not wanted:
        return []
    rows = await session.execute(
        select(WeaknessLoop.id)
        .join(WeaknessCard, WeaknessCard.id == WeaknessLoop.weakness_id)
        .where(WeaknessLoop.id.in_(wanted), WeaknessCard.user_id == user_id)
    )
    owned = {row[0] for row in rows.all()}
    seen: set[int] = set()
    result: list[int] = []
    for i in wanted:
        if i in owned and i not in seen:
            seen.add(i)
            result.append(i)
    return result


@router.get("")
async def list_principles(
    status: str | None = None,
    status_filter: str = "candidate,active",
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Principle).where(Principle.user_id == user.id)
    # 同时接受 status 与 status_filter：
    # API.md 第 3 章把参数写作 status，早期实现用的是 status_filter，
    # 两个名字都放行，避免任何一侧静默失效（筛选参数写错不会报错，
    # 只会返回全部数据——这类缺陷在页面上极难发现）。
    wanted = [s.strip() for s in (status or status_filter).split(",") if s.strip()]
    if wanted:
        stmt = stmt.where(Principle.status.in_(wanted))

    # 置顶优先，然后新→旧
    rows = await session.execute(
        stmt.order_by(Principle.pinned.desc(), Principle.id.desc()).limit(200)
    )
    items = list(rows.scalars().all())

    payload = []
    for principle in items:
        payload.append(principle_out(principle, linked_loops=await _linked_loops(session, principle)))

    return {
        "principles": payload,
        "total": len(items),
        "candidate_count": sum(1 for p in items if p.status == "candidate"),
    }


@router.post("", status_code=201)
async def create_principle(
    payload: CreatePrinciplePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """用户手动新建（来源置信度：中）。"""
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="原则内容不能为空")

    confidence = payload.confidence if payload.confidence in VALID_CONFIDENCE else "medium"

    principle = Principle(
        user_id=user.id,
        content=content,
        source_type="manual",
        status="active",  # 手动新建的直接启用，不需要再确认一次
        confidence=confidence,
        linked_loop_ids=await _owned_loop_ids(session, payload.linked_loop_ids, user.id),
    )
    session.add(principle)
    await session.commit()
    await session.refresh(principle)

    return {"principle": principle_out(principle, linked_loops=await _linked_loops(session, principle))}


@router.patch("/{principle_id}")
async def update_principle(
    principle_id: int,
    payload: UpdatePrinciplePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    principle = await _get_owned(session, principle_id, user)

    if payload.content is not None:
        content = payload.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="原则内容不能为空")
        principle.content = content

    if payload.pinned is not None:
        principle.pinned = payload.pinned

    if payload.linked_loop_ids is not None:
        # 一条原则可关联多个回环（只接受属于自己的那些）
        principle.linked_loop_ids = await _owned_loop_ids(
            session, payload.linked_loop_ids, user.id
        )

    principle.updated_at = now_utc()
    await session.commit()
    await session.refresh(principle)

    return {"principle": principle_out(principle, linked_loops=await _linked_loops(session, principle))}


@router.post("/{principle_id}/confirm")
async def confirm_principle(
    principle_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """候选 → 启用。"""
    principle = await _get_owned(session, principle_id, user)
    principle.status = "active"
    principle.updated_at = now_utc()
    await session.commit()
    return {"principle": principle_out(principle, linked_loops=await _linked_loops(session, principle))}


@router.post("/{principle_id}/ignore")
async def ignore_principle(
    principle_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """忽略留痕：不删除记录，让 AI 知道这条推过了、别再推。"""
    principle = await _get_owned(session, principle_id, user)
    principle.status = "ignored"
    principle.updated_at = now_utc()
    await session.commit()
    return {"ok": True}


@router.post("/{principle_id}/archive")
async def archive_principle(
    principle_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    principle = await _get_owned(session, principle_id, user)
    principle.status = "archived"
    principle.updated_at = now_utc()
    await session.commit()
    return {"ok": True}


@router.post("/{principle_id}/restore")
async def restore_principle(
    principle_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """归档可恢复（方案 3.6）。"""
    principle = await _get_owned(session, principle_id, user)
    if principle.status not in ("archived", "ignored"):
        raise HTTPException(status_code=409, detail="这条原则当前无需恢复")
    principle.status = "active"
    principle.updated_at = now_utc()
    await session.commit()
    return {"principle": principle_out(principle, linked_loops=await _linked_loops(session, principle))}
