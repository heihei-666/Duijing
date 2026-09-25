"""对镜 · AI 观察候选

方案 3.8 关于 AI 观察候选的两条规则，是这里最容易做错的：
  · 存活 24 小时
  · **从首次看到算，不是从生成算**（第九章第 9 条）

所以 first_seen_at 必须在「第一次被读出来」的那一刻写入，
而不是在创建时写。任何返回候选的接口（首页状态栏、观察列表）
都要经过 mark_first_seen()。
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import (
    Advantage,
    AIObservation,
    ObservationStatus,
    ObservationType,
    User,
    WeaknessCard,
)
from app.utils import now_utc


async def create_observation(
    session: AsyncSession,
    *,
    user_id: int,
    obs_type: str,
    content: str,
    source_type: str,
    source_id: int | None = None,
) -> AIObservation:
    """创建候选。注意：这里**不**设置 expires_at——倒计时从首次看到才开始。"""
    obs = AIObservation(
        user_id=user_id,
        type=obs_type,
        content=content.strip(),
        source_type=source_type,
        source_id=source_id,
        status=ObservationStatus.PENDING.value,
    )
    session.add(obs)
    await session.flush()
    return obs


async def mark_first_seen(session: AsyncSession, observations: list[AIObservation]) -> None:
    """把本轮返回的候选标记为「已看到」，并据此定下过期时间。"""
    if not observations:
        return

    now = now_utc()
    ttl = timedelta(hours=settings.OBSERVATION_TTL_HOURS)
    dirty = False

    for obs in observations:
        if obs.first_seen_at is None:
            obs.first_seen_at = now
            obs.expires_at = now + ttl
            dirty = True

    if dirty:
        await session.flush()


async def list_pending(
    session: AsyncSession,
    user_id: int,
    *,
    limit: int | None = None,
    mark_seen: bool = True,
) -> list[AIObservation]:
    """待处理候选。

    过滤条件里 status=pending 已经足够：过期的会被定时任务转成 expired，
    且只有未过期的才会被返回。这里再兜一层 expires_at 判断，
    防止定时任务没跑到时把已过期的候选露给用户。
    """
    now = now_utc()
    stmt = (
        select(AIObservation)
        .where(
            AIObservation.user_id == user_id,
            AIObservation.status == ObservationStatus.PENDING.value,
        )
        .order_by(AIObservation.created_at.desc())
    )
    if limit:
        stmt = stmt.limit(limit)

    rows = await session.execute(stmt)
    items = [
        obs
        for obs in rows.scalars().all()
        if obs.expires_at is None or obs.expires_at > now
    ]

    if mark_seen:
        await mark_first_seen(session, items)
        # 标记后重新筛一遍：极端情况下同一批里有刚过期的
        items = [
            obs for obs in items if obs.expires_at is None or obs.expires_at > now
        ]
    return items


async def accept(
    session: AsyncSession, obs: AIObservation, user: User
) -> tuple[str, int]:
    """加入 → 建弱点卡，或优势入库。

    返回 (kind, id)，kind ∈ {weakness, advantage}。
    """
    obs.status = ObservationStatus.ACCEPTED.value

    if obs.type == ObservationType.WEAKNESS.value:
        card = WeaknessCard(
            user_id=user.id,
            name=obs.content[:120],
            description=_source_note(obs),
            domains=[],
            status="observing",
            confidence=3,
            source="ai",
            source_id=obs.id,
        )
        session.add(card)
        await session.flush()
        return "weakness", card.id

    # 优势：AI 观察自动入库，标记待确认（方案 3.5）
    existing = await session.scalar(
        select(Advantage).where(
            Advantage.user_id == user.id,
            Advantage.name == obs.content[:120],
        )
    )
    if existing is not None:
        # 用户移除过的标签不再重复入库
        if existing.status == "removed":
            return "advantage", existing.id
        existing.status = "pending"
        existing.verified = False
        return "advantage", existing.id

    advantage = Advantage(
        user_id=user.id,
        name=obs.content[:120],
        source="ai",
        source_id=obs.id,
        verified=False,
        status="pending",
    )
    session.add(advantage)
    await session.flush()
    return "advantage", advantage.id


async def ignore(session: AsyncSession, obs: AIObservation) -> None:
    obs.status = ObservationStatus.IGNORED.value
    await session.flush()


async def expire_stale(session: AsyncSession) -> int:
    """把过了 24 小时的候选转成 expired。由定时任务调用。

    只处理「已经被看到过」的候选——从没被看到过的候选不该凭空消失。
    """
    rows = await session.execute(
        select(AIObservation).where(
            AIObservation.status == ObservationStatus.PENDING.value,
            AIObservation.expires_at.is_not(None),
            AIObservation.expires_at <= now_utc(),
        )
    )
    items = list(rows.scalars().all())
    for obs in items:
        obs.status = ObservationStatus.EXPIRED.value
    await session.flush()
    return len(items)


def _source_note(obs: AIObservation) -> str:
    origin = {
        "debate": "来自辩论房观察",
        "event_card": "来自事件卡扫描",
        "scan": "来自事件卡扫描",
    }.get(obs.source_type, "来自 AI 观察")
    if obs.source_id:
        return f"{origin}（来源 #{obs.source_id}）"
    return origin
