"""对镜 · 归档 / 垃圾桶 API

方案 3.8 的归档规则表：

    对象          归档规则                              恢复
    弱点          拖垃圾桶 → archived，60 天倒计时        拖回黑板 → observing，触发计数保留
    优势          待确认 30 天超时归档                    可恢复
    原则          手动归档                              可恢复
    AI 观察候选   24 小时，从首次看到算                  不恢复
    事件卡        永久保留                              —
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Advantage, ArchiveRecord, Principle, User, WeaknessCard
from app.services import loops as loop_service
from app.services.serializers import advantage_out, principle_out, _days_until
from app.utils import iso_utc

router = APIRouter(prefix="/api/archive", tags=["垃圾桶"])


@router.get("")
async def get_archive(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # 弱点：60 天倒计时
    weakness_rows = await session.execute(
        select(WeaknessCard)
        .where(WeaknessCard.user_id == user.id, WeaknessCard.status == "archived")
        .order_by(WeaknessCard.delete_after.asc().nulls_last())
    )
    # 走统一的组装函数，避免漏传统计字段导致 drill_count 恒为 0
    weaknesses = []
    for card in weakness_rows.scalars().all():
        payload = await loop_service.weakness_payload(session, card)
        payload["restorable"] = True
        payload["expires_in_days"] = _days_until(card.delete_after)
        weaknesses.append(payload)

    # 优势：待确认超 30 天归档，可恢复
    advantage_rows = await session.execute(
        select(Advantage)
        .where(Advantage.user_id == user.id, Advantage.status.in_(["archived", "removed"]))
        .order_by(Advantage.id.desc())
    )
    advantages = [{**advantage_out(adv), "restorable": True} for adv in advantage_rows.scalars().all()]

    # 原则：手动归档，可恢复
    principle_rows = await session.execute(
        select(Principle)
        .where(Principle.user_id == user.id, Principle.status.in_(["archived", "ignored"]))
        .order_by(Principle.id.desc())
    )
    principles = [
        {**principle_out(item), "restorable": True} for item in principle_rows.scalars().all()
    ]

    # 归档流水，便于前端展示「什么时候进的垃圾桶」
    record_rows = await session.execute(
        select(ArchiveRecord)
        .where(ArchiveRecord.user_id == user.id)
        .order_by(ArchiveRecord.id.desc())
        .limit(50)
    )
    records = [
        {
            "id": rec.id,
            "object_type": rec.object_type,
            "object_id": rec.object_id,
            "reason": rec.reason,
            "archived_at": iso_utc(rec.archived_at),
            "delete_after": iso_utc(rec.delete_after),
            "restored_at": iso_utc(rec.restored_at),
            "days_until_delete": _days_until(rec.delete_after),
        }
        for rec in record_rows.scalars().all()
    ]

    return {
        "weaknesses": weaknesses,
        "advantages": advantages,
        "principles": principles,
        "records": records,
        "rules": {
            "weakness_delete_days": settings.WEAKNESS_DELETE_DAYS,
            "advantage_archive_days": settings.ADVANTAGE_ARCHIVE_DAYS,
            "observation_ttl_hours": settings.OBSERVATION_TTL_HOURS,
            "observation_restorable": False,
            "event_card_permanent": True,
        },
    }


@router.post("/purge")
async def purge_expired(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """手动清理超过 60 天的弱点。

    定时任务每天也会跑一次；这个接口给「我现在就想清干净」的场景。
    注意：这是**物理删除**，不可恢复。
    """
    deleted = await loop_service.purge_expired_weaknesses(session)
    await session.commit()
    return {"deleted": deleted}
