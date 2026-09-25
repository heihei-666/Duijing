"""对镜 · 回环与撑住率

系统里最容易写错、也最不能写错的一块。

方案第九章第 7 条：**所有经验变动必须写 loop_log，不直接改弱点状态。**
所以本模块把「记录一次演练」当作唯一入口，状态变更都是它的副作用。

撑住率定义（方案 3.3）：
    近 30 天撑住率 = 撑住次数 / 触发次数
其中「触发」= 撑住 + 破功；「未触发」不计入分母。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import (
    Advantage,
    ArchiveRecord,
    LoopLog,
    LoopResult,
    LoopStatus,
    Principle,
    WeaknessCard,
    WeaknessLoop,
)
from app.utils import hold_rate, local_today, now_utc, rate_bucket

TRIGGER_RESULTS = (LoopResult.HOLD.value, LoopResult.BREAK.value)


@dataclass(slots=True)
class Stats:
    """近 30 天统计。"""

    trigger_count: int = 0
    hold_count: int = 0
    break_count: int = 0
    not_triggered_count: int = 0

    @property
    def rate(self) -> int:
        return hold_rate(self.hold_count, self.trigger_count)

    @property
    def bucket(self) -> str:
        return rate_bucket(self.rate)


def _window_start(days: int) -> date_type:
    """近 N 天窗口的起始日期（含今天）。"""
    return local_today() - timedelta(days=days - 1)


# ─────────────────────────────────────────────────────────────
# 统计
# ─────────────────────────────────────────────────────────────


async def loop_stats(
    session: AsyncSession, loop_ids: list[int], *, days: int = 30
) -> dict[int, Stats]:
    """批量取多个回环的近 30 天统计。一次查询搞定，避免 N+1。"""
    if not loop_ids:
        return {}

    rows = await session.execute(
        select(LoopLog.loop_id, LoopLog.result, func.count(LoopLog.id))
        .where(LoopLog.loop_id.in_(loop_ids), LoopLog.date >= _window_start(days))
        .group_by(LoopLog.loop_id, LoopLog.result)
    )

    result: dict[int, Stats] = {lid: Stats() for lid in loop_ids}
    for loop_id, outcome, count in rows.all():
        stats = result.setdefault(loop_id, Stats())
        _accumulate(stats, outcome, count)
    return result


async def weakness_stats(
    session: AsyncSession, weakness_ids: list[int], *, days: int = 30
) -> dict[int, Stats]:
    """批量取多个弱点的近 30 天统计（跨该弱点下所有回环汇总）。"""
    if not weakness_ids:
        return {}

    rows = await session.execute(
        select(LoopLog.weakness_id, LoopLog.result, func.count(LoopLog.id))
        .where(LoopLog.weakness_id.in_(weakness_ids), LoopLog.date >= _window_start(days))
        .group_by(LoopLog.weakness_id, LoopLog.result)
    )

    result: dict[int, Stats] = {wid: Stats() for wid in weakness_ids}
    for weakness_id, outcome, count in rows.all():
        stats = result.setdefault(weakness_id, Stats())
        _accumulate(stats, outcome, count)
    return result


def _accumulate(stats: Stats, outcome: str, count: int) -> None:
    if outcome == LoopResult.HOLD.value:
        stats.hold_count += count
        stats.trigger_count += count
    elif outcome == LoopResult.BREAK.value:
        stats.break_count += count
        stats.trigger_count += count
    elif outcome == LoopResult.NOT_TRIGGERED.value:
        stats.not_triggered_count += count


async def drill_counts(session: AsyncSession, weakness_ids: list[int]) -> dict[int, int]:
    """每个弱点的累计演练次数（全时段，不限 30 天）——便签角标的「演练 3」。"""
    if not weakness_ids:
        return {}
    rows = await session.execute(
        select(LoopLog.weakness_id, func.count(LoopLog.id))
        .where(LoopLog.weakness_id.in_(weakness_ids))
        .group_by(LoopLog.weakness_id)
    )
    counts = {wid: 0 for wid in weakness_ids}
    counts.update({wid: count for wid, count in rows.all()})
    return counts


async def plan_counts(session: AsyncSession, weakness_ids: list[int]) -> dict[int, int]:
    """每个弱点的预案（回环）数量——便签角标的「预案 1」。"""
    if not weakness_ids:
        return {}
    rows = await session.execute(
        select(WeaknessLoop.weakness_id, func.count(WeaknessLoop.id))
        .where(WeaknessLoop.weakness_id.in_(weakness_ids))
        .group_by(WeaknessLoop.weakness_id)
    )
    counts = {wid: 0 for wid in weakness_ids}
    counts.update({wid: count for wid, count in rows.all()})
    return counts


async def recent_logs(
    session: AsyncSession, loop_id: int, *, limit: int = 20
) -> list[LoopLog]:
    rows = await session.execute(
        select(LoopLog)
        .where(LoopLog.loop_id == loop_id)
        .order_by(LoopLog.date.desc(), LoopLog.id.desc())
        .limit(limit)
    )
    return list(rows.scalars().all())


# ─────────────────────────────────────────────────────────────
# 写入
# ─────────────────────────────────────────────────────────────


async def record_log(
    session: AsyncSession,
    *,
    loop: WeaknessLoop,
    user_id: int,
    result: str,
    note: str = "",
    source: str = "manual",
    source_id: int | None = None,
    on_date: date_type | None = None,
) -> LoopLog:
    """写一条演练日志，并施加它带来的副作用。

    副作用（顺序不能乱）：
      1. 落一条 loop_log —— 事实来源
      2. 刷新弱点卡上的 trigger_count_30d 物化缓存
      3. result=break 时把回环推进「待修订」（方案 3.3）
    """
    log = LoopLog(
        loop_id=loop.id,
        weakness_id=loop.weakness_id,
        user_id=user_id,
        date=on_date or local_today(),
        result=result,
        note=note or "",
        source=source,
        source_id=source_id,
    )
    session.add(log)
    await session.flush()

    await _refresh_trigger_cache(session, loop.weakness_id)

    if result == LoopResult.BREAK.value and loop.status == LoopStatus.ACTIVE.value:
        loop.status = LoopStatus.NEEDS_REVISION.value
        loop.updated_at = now_utc()

    return log


async def _refresh_trigger_cache(session: AsyncSession, weakness_id: int) -> None:
    """把近 30 天触发次数写回弱点卡，供列表页快速读取。"""
    stats = await weakness_stats(session, [weakness_id])
    card = await session.get(WeaknessCard, weakness_id)
    if card is not None:
        card.trigger_count_30d = stats.get(weakness_id, Stats()).trigger_count


# ─────────────────────────────────────────────────────────────
# 降级 / 归档
# ─────────────────────────────────────────────────────────────


def should_suggest_downgrade(stats: Stats) -> bool:
    """方案 3.3：撑住率 ≥ 80% 且触发次数 ≥ 5 → 提示用户确认。

    **只是提示，绝不自动降级**（第九章第 8 条）。
    """
    return stats.rate >= 80 and stats.trigger_count >= 5


def should_suggest_archive(stats: Stats) -> bool:
    """长期 0 触发 → 提示「是否降级为观察存档」。"""
    return stats.trigger_count == 0 and stats.not_triggered_count == 0


async def archive_weakness(
    session: AsyncSession,
    card: WeaknessCard,
    *,
    reason: str = "manual",
) -> ArchiveRecord:
    """移入垃圾桶：设 60 天倒计时，触发计数保留。"""
    now = now_utc()
    card.status = "archived"
    card.archived_at = now
    card.delete_after = now + timedelta(days=settings.WEAKNESS_DELETE_DAYS)

    record = ArchiveRecord(
        user_id=card.user_id,
        object_type="weakness",
        object_id=card.id,
        reason=reason,
        archived_at=now,
        delete_after=card.delete_after,
    )
    session.add(record)
    await session.flush()
    return record


async def restore_weakness(session: AsyncSession, card: WeaknessCard) -> None:
    """从垃圾桶拖回黑板 → observing，触发计数保留（不清零）。"""
    card.status = "observing"
    card.archived_at = None
    card.delete_after = None

    record = await session.scalar(
        select(ArchiveRecord)
        .where(
            ArchiveRecord.object_type == "weakness",
            ArchiveRecord.object_id == card.id,
            ArchiveRecord.restored_at.is_(None),
        )
        .order_by(ArchiveRecord.id.desc())
    )
    if record is not None:
        record.restored_at = now_utc()
    await session.flush()


async def purge_expired_weaknesses(session: AsyncSession) -> int:
    """物理删除超过 60 天倒计时的弱点。由定时任务调用。"""
    rows = await session.execute(
        select(WeaknessCard).where(
            WeaknessCard.status == "archived",
            WeaknessCard.delete_after.is_not(None),
            WeaknessCard.delete_after <= now_utc(),
        )
    )
    cards = list(rows.scalars().all())
    for card in cards:
        await session.delete(card)
    await session.flush()
    return len(cards)


# ─────────────────────────────────────────────────────────────
# 回环创建与关联
# ─────────────────────────────────────────────────────────────


async def create_loop(
    session: AsyncSession,
    *,
    weakness: WeaknessCard,
    trigger_scene: str,
    body_signal: str = "",
    action_plan: str = "",
    activate: bool = False,
    linked_advantage_ids: list[int] | None = None,
    linked_principle_ids: list[int] | None = None,
) -> WeaknessLoop:
    loop = WeaknessLoop(
        weakness_id=weakness.id,
        trigger_scene=trigger_scene.strip(),
        body_signal=(body_signal or "").strip(),
        action_plan=(action_plan or "").strip(),
        status=LoopStatus.ACTIVE.value if activate else LoopStatus.DRAFT.value,
        linked_advantage_ids=list(linked_advantage_ids or []),
        linked_principle_ids=list(linked_principle_ids or []),
    )
    session.add(loop)

    # 建了回环，弱点就从「观察中」进入「改善中」（方案 3.2 四区流转）
    if activate and weakness.status == "observing":
        weakness.status = "improving"

    await session.flush()
    return loop


async def load_linked_assets(
    session: AsyncSession, loop: WeaknessLoop
) -> tuple[list[Advantage], list[Principle]]:
    """取回环预案里引用的优势与原则。"""
    advantage_ids = list(loop.linked_advantage_ids or [])
    principle_ids = list(loop.linked_principle_ids or [])

    advantages: list[Advantage] = []
    if advantage_ids:
        rows = await session.execute(select(Advantage).where(Advantage.id.in_(advantage_ids)))
        advantages = list(rows.scalars().all())

    principles: list[Principle] = []
    if principle_ids:
        rows = await session.execute(select(Principle).where(Principle.id.in_(principle_ids)))
        principles = list(rows.scalars().all())

    return advantages, principles


def suggest_downgrade_payload(stats: Stats) -> dict:
    """给前端的一句提示，不含任何自动动作。"""
    return {
        "suggest_downgrade": True,
        "reason": f"近 30 天撑住率 {stats.rate}%，触发 {stats.trigger_count} 次，已达降级标准",
        "hint": "确认后将移入暂存区，可在垃圾桶恢复",
    }


async def weakness_payload(session: AsyncSession, card: WeaknessCard) -> dict:
    """组装单张弱点卡的完整对外结构（含全部统计字段）。

    存在的意义：weakness_out() 的统计参数都有默认值 0，
    任何一处忘记传参，接口就会返回 drill_count=0 这类**看似正常实则错误**
    的数据。归档、恢复、新建、修改四个接口统一走这里，杜绝漏传。
    """
    from app.services.serializers import weakness_out

    stats = (await weakness_stats(session, [card.id])).get(card.id, Stats())
    drills = (await drill_counts(session, [card.id])).get(card.id, 0)
    plans = (await plan_counts(session, [card.id])).get(card.id, 0)

    return weakness_out(
        card,
        trigger_count=stats.trigger_count,
        hold_count=stats.hold_count,
        hold_rate=stats.rate,
        plan_count=plans,
        drill_count=drills,
    )
