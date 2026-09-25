"""对镜 · 状态栏（首页四块）

方案 3.7 的规则，逐条落实：
  · 今天练什么 → 最多 2 条回环
  · 精力/心情可跳过，不填不显示
  · AI 观察候选 24 小时从首次看到算
  · 空状态各块自行收形
方案第九章第 6 条：状态栏只做轻操作——不能写日记、建原则、开辩论。
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DailyState,
    EventCard,
    LoopLog,
    LoopStatus,
    User,
    WeaknessCard,
    WeaknessLoop,
)
from app.services import observations as observation_service
from app.services.loops import loop_stats
from app.utils import iso_utc, local_today, weekday_cn

TODAY_LOOPS_LIMIT = 2
LOOKBACK_DAYS = 400


async def compute_streak(session: AsyncSession, user_id: int) -> int:
    """连续天数。

    定义（已与产品确认）：**当天有实战记录就算**——
    即当天写过事件卡，或写过任一演练日志（loop_log）。

    今天还没记录时，从昨天往前数：这样用户白天打开 App
    不会看到连续天数突然归零。
    """
    since = local_today() - timedelta(days=LOOKBACK_DAYS)

    log_dates = await session.execute(
        select(LoopLog.date).where(LoopLog.user_id == user_id, LoopLog.date >= since).distinct()
    )
    card_dates = await session.execute(
        select(EventCard.created_at).where(EventCard.user_id == user_id)
    )

    active_days: set = {row[0] for row in log_dates.all()}
    for (created_at,) in card_dates.all():
        if created_at is not None:
            from app.utils import utc_to_local

            local = utc_to_local(created_at)
            if local and local.date() >= since:
                active_days.add(local.date())

    if not active_days:
        return 0

    today = local_today()
    cursor = today if today in active_days else today - timedelta(days=1)

    streak = 0
    while cursor in active_days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


async def get_today_state(session: AsyncSession, user_id: int) -> DailyState | None:
    return await session.scalar(
        select(DailyState).where(
            DailyState.user_id == user_id, DailyState.date == local_today()
        )
    )


async def get_today_loops(session: AsyncSession, user_id: int) -> list[dict]:
    """今天练什么：启用中的回环，最多 2 条。

    排序按撑住率升序——最该练的排最前。
    """
    rows = await session.execute(
        select(WeaknessLoop, WeaknessCard)
        .join(WeaknessCard, WeaknessLoop.weakness_id == WeaknessCard.id)
        .where(
            WeaknessCard.user_id == user_id,
            # 含 needs_revision：破功后回环进入待修订，那恰恰是最该被看见的时刻，
            # 如果这时把它从首页拿掉，用户第二天打开 App 会发现"没什么可练的"。
            # 不含 paused：方案 3.3 明确"暂停后不推送演练"。
            WeaknessLoop.status.in_(
                (LoopStatus.ACTIVE.value, LoopStatus.NEEDS_REVISION.value)
            ),
            WeaknessCard.status != "archived",
        )
    )
    pairs = rows.all()
    if not pairs:
        return []

    stats = await loop_stats(session, [loop.id for loop, _ in pairs])

    items = []
    for loop, weakness in pairs:
        st = stats.get(loop.id)
        rate = st.rate if st else 0
        items.append(
            {
                "loop_id": loop.id,
                "weakness_id": weakness.id,
                "title": (loop.action_plan or loop.trigger_scene or weakness.name)[:60],
                "weakness_name": weakness.name,
                "hold_rate_30d": rate,
                "trigger_count_30d": st.trigger_count if st else 0,
                "rate_bucket": st.bucket if st else "low",
            }
        )

    items.sort(key=lambda item: (item["hold_rate_30d"], item["loop_id"]))
    return items[:TODAY_LOOPS_LIMIT]


async def build_status_bar(session: AsyncSession, user: User) -> dict:
    """组装首页四块。"""
    today = local_today()

    state = await get_today_state(session, user.id)
    streak = await compute_streak(session, user.id)
    loops = await get_today_loops(session, user.id)

    # 首页展示 AI 观察候选时，同时开始 24 小时倒计时
    pending = await observation_service.list_pending(session, user.id, limit=1, mark_seen=True)

    return {
        "date": today.isoformat(),
        "weekday": weekday_cn(today),
        "energy": state.energy if state else None,
        "mood": state.mood if state else None,
        "streak_days": streak,
        "today_loops": loops,
        "observations": [
            {
                "id": obs.id,
                "type": obs.type,
                "content": obs.content,
                "created_at": iso_utc(obs.created_at),
            }
            for obs in pending
        ],
    }
