"""对镜 · 回环与撑住率

系统里最容易写错、也最不能写错的一块。

方案第九章第 7 条：**所有经验变动必须写 loop_log，不直接改弱点状态。**
所以本模块把「记录一次演练」当作唯一入口，状态变更都是它的副作用。

撑住率定义（方案 3.3）：
    近 30 天撑住率 = 撑住次数 / 触发次数
其中「触发」= 撑住 + 破功；「未触发」不计入分母。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date as date_type
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.prompts import build_principle_messages
from app.ai.router import TASK_PRINCIPLE, complete, extract_json
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

logger = logging.getLogger("duijing.loops")

TRIGGER_RESULTS = (LoopResult.HOLD.value, LoopResult.BREAK.value)


@dataclass(slots=True)
class Stats:
    """近 30 天统计。"""

    trigger_count: int = 0
    hold_count: int = 0
    break_count: int = 0
    not_triggered_count: int = 0

    @property
    def rate(self) -> int | None:
        """撑住率。**无触发时为 None**，前端据此显示「--」而不是 0%。"""
        return hold_rate(self.hold_count, self.trigger_count)

    @property
    def has_data(self) -> bool:
        return self.trigger_count > 0

    @property
    def bucket(self) -> str | None:
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


@dataclass(slots=True)
class Trend:
    """本周与上周的撑住率对比。

    用来回答用户最想知道的那个问题：**我在变好吗？**
    只有 30 天撑住率这一个静态数字是不够的——用户努力了三周，
    看到的还是「67%」，他无法感知自己的进步。

    两个窗口都没有触发数据时，delta 为 None，前端不显示（而不是显示 0）。
    """

    rate_7d: int | None = None
    rate_prev_7d: int | None = None

    @property
    def delta(self) -> int | None:
        if self.rate_7d is None or self.rate_prev_7d is None:
            return None
        return self.rate_7d - self.rate_prev_7d


async def _window_stats(
    session: AsyncSession, ids: list[int], *, column, start: date_type, end: date_type
) -> dict[int, Stats]:
    rows = await session.execute(
        select(column, LoopLog.result, func.count(LoopLog.id))
        .where(column.in_(ids), LoopLog.date >= start, LoopLog.date <= end)
        .group_by(column, LoopLog.result)
    )
    result: dict[int, Stats] = {i: Stats() for i in ids}
    for key, outcome, count in rows.all():
        _accumulate(result.setdefault(key, Stats()), outcome, count)
    return result


def _trend_from(cur: dict[int, Stats], prev: dict[int, Stats], ids: list[int]) -> dict[int, Trend]:
    out: dict[int, Trend] = {}
    for i in ids:
        c = cur.get(i, Stats())
        pv = prev.get(i, Stats())
        out[i] = Trend(rate_7d=c.rate, rate_prev_7d=pv.rate)
    return out


async def loop_trends(session: AsyncSession, loop_ids: list[int]) -> dict[int, Trend]:
    """回环的「本周 vs 上周」趋势。"""
    if not loop_ids:
        return {}
    today = local_today()
    cur = await _window_stats(
        session, loop_ids, column=LoopLog.loop_id,
        start=today - timedelta(days=6), end=today,
    )
    prev = await _window_stats(
        session, loop_ids, column=LoopLog.loop_id,
        start=today - timedelta(days=13), end=today - timedelta(days=7),
    )
    return _trend_from(cur, prev, loop_ids)


async def weakness_trends(session: AsyncSession, weakness_ids: list[int]) -> dict[int, Trend]:
    """弱点的「本周 vs 上周」趋势（跨该弱点下所有回环汇总）。"""
    if not weakness_ids:
        return {}
    today = local_today()
    cur = await _window_stats(
        session, weakness_ids, column=LoopLog.weakness_id,
        start=today - timedelta(days=6), end=today,
    )
    prev = await _window_stats(
        session, weakness_ids, column=LoopLog.weakness_id,
        start=today - timedelta(days=13), end=today - timedelta(days=7),
    )
    return _trend_from(cur, prev, weakness_ids)


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
    return stats.has_data and stats.rate is not None and stats.rate >= 80 and stats.trigger_count >= 5


def should_suggest_archive(stats: Stats) -> bool:
    """长期 0 触发 → 提示「是否降级为观察存档」。"""
    return stats.trigger_count == 0 and stats.not_triggered_count == 0


# ─────────────────────────────────────────────────────────────
# 原则候选：方案的第二条核心数据流
# ─────────────────────────────────────────────────────────────
#
# 方案第 748-751 行把两条数据流定义为「这两条不断，系统就活着」：
#
#   1. 辩论房/事件卡 → ai_observation → 弱点/优势 → 回环 → loop_log → 撑住率
#   2. **回环撑住率达标 → principle 候选 → 原则启用 → 反向挂回环**
#
# 第 2 条此前是断的：`PrincipleSource.LOOP_RATE`（方案里置信度最高的来源）
# 从未被赋值，`TASK_PRINCIPLE` 与 `build_principle_messages()` 写好了却没有任何调用点，
# 全仓库只有「手动新建」和「辩论房结论」两个来源。
# 下面这个函数就是把断掉的那一段接上。


async def maybe_create_principle_candidate(
    session: AsyncSession,
    *,
    loop: WeaknessLoop,
    user_id: int,
) -> Principle | None:
    """撑住率达标时，从「用户实际做对的动作」里提炼一条原则候选。

    触发条件与降级提示**完全一致**（方案 3.3：撑住率 ≥80% 且触发 ≥5），
    因为它们描述的是同一件事：「这个回环已经练成了」。
    区别只是出口不同——降级提示是「可以收工了」，原则是「把经验留下来」。

    置信度给 `high`：方案 3.6 的来源表里，「回环撑住率达标」是唯一标为高置信度的，
    因为它是从用户**已经验证过的行为**里提炼的，不是模型凭空的建议。

    **幂等**：同一个回环只生成一次（按 source_type+source_id 查重）。
    否则用户每记一次演练就会多一条候选，原则库很快被同一个回环刷屏。
    """
    stats = (await loop_stats(session, [loop.id])).get(loop.id, Stats())
    if not should_suggest_downgrade(stats):
        return None

    existing = await session.scalar(
        select(Principle).where(
            Principle.user_id == user_id,
            Principle.source_type == "loop_rate",
            Principle.source_id == loop.id,
        )
    )
    if existing is not None:
        return None

    weakness = await session.get(WeaknessCard, loop.weakness_id)
    loop_desc = "\n".join(
        part
        for part in (
            f"【触发场景】{loop.trigger_scene}",
            f"【身体/情绪信号】{loop.body_signal}" if loop.body_signal else "",
            f"【预案】{loop.action_plan}" if loop.action_plan else "",
            f"【对应弱点】{weakness.name}" if weakness is not None else "",
            f"【近 30 天】撑住 {stats.hold_count} / 触发 {stats.trigger_count}"
            f"（{stats.rate:.0f}%）",
        )
        if part
    )

    logs = await recent_logs(session, loop.id, limit=20)
    logs_text = (
        "\n".join(f"- {log.date} {log.result}｜{log.note}" for log in logs if log.note)
        or "（用户没有写复盘备注）"
    )

    response = await complete(
        TASK_PRINCIPLE,
        build_principle_messages(loop_desc, logs_text),
        temperature=0.5,
        max_tokens=300,
    )
    payload = extract_json(response.text) or {}
    content = (payload.get("content") or "").strip()
    if not content:
        # 提炼不出来就当没发生：宁可少一条原则，也不要塞一条空话进原则库。
        # 调用方是后台任务，异常只会被记日志，不影响用户这一次的「记一笔」。
        logger.info("回环 #%s 撑住率达标但未提炼出原则，跳过", loop.id)
        return None

    # 内容级去重：同一条原则可能已经从别的回环得出
    duplicate = await session.scalar(
        select(Principle).where(
            Principle.user_id == user_id,
            Principle.content == content[:200],
        )
    )
    if duplicate is not None:
        return None

    principle = Principle(
        user_id=user_id,
        content=content[:200],
        source_type="loop_rate",
        source_id=loop.id,
        status="candidate",  # 候选，等用户确认（方案 3.6：候选 → 启用 → 归档）
        confidence="high",
        # 方案第 751 行的「反向挂回环」：原则从哪个回环提炼出来，就挂回哪个回环。
        # 这样用户在原则库看到它时，能直接跳回当时练的那个场景。
        linked_loop_ids=[loop.id],
    )
    session.add(principle)
    await session.flush()
    logger.info("回环 #%s 撑住率达标，生成原则候选 #%s", loop.id, principle.id)
    return principle


async def generate_principle_candidate_task(loop_id: int, user_id: int) -> int | None:
    """后台任务入口：自己开 session、自己吞异常。

    为什么放后台：这是一次真实的模型调用（几秒），
    而「记一笔」是用户日常最高频的动作，不能让它等模型。
    失败也**不能**影响那次记录——演练日志已经落库了，原则只是附加产物。
    """
    from app.db import session_scope

    try:
        async with session_scope() as session:
            loop = await session.get(WeaknessLoop, loop_id)
            if loop is None:
                return None
            # 二次确认归属：后台任务不经过依赖注入，必须自己检查
            weakness = await session.get(WeaknessCard, loop.weakness_id)
            if weakness is None or weakness.user_id != user_id:
                logger.warning("回环 #%s 不属于 user=%s，跳过原则提炼", loop_id, user_id)
                return None
            principle = await maybe_create_principle_candidate(
                session, loop=loop, user_id=user_id
            )
            return principle.id if principle else None
    except Exception:  # noqa: BLE001
        logger.exception("回环 #%s 的原则候选生成失败（不影响演练记录）", loop_id)
        return None


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


async def purge_expired_weaknesses(session: AsyncSession, *, user_id: int | None = None) -> int:
    """物理删除超过 60 天倒计时的弱点。

    **user_id 是安全边界，不是可选优化。**

    - `user_id=None` → 全局清理，**只有定时任务可以这么调**（`scheduler.py`）。
    - `user_id=<id>` → 只清这个用户的，给 `POST /api/archive/purge` 用。

    这里曾经没有 user_id 参数，而手动接口又直接调了它 —— 结果是**任何登录用户
    都能一个请求物理删掉全站所有过期弱点**（跨租户破坏，且不可恢复）。
    加参数时请保留默认值 None，让定时任务那条路径不用改。
    """
    stmt = select(WeaknessCard).where(
        WeaknessCard.status == "archived",
        WeaknessCard.delete_after.is_not(None),
        WeaknessCard.delete_after <= now_utc(),
    )
    if user_id is not None:
        stmt = stmt.where(WeaknessCard.user_id == user_id)

    rows = await session.execute(stmt)
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
    session: AsyncSession, loop: WeaknessLoop, *, user_id: int
) -> tuple[list[Advantage], list[Principle]]:
    """取回环预案里引用的优势与原则。

    `user_id` **必须传**，且必须来自当前登录用户：
    `linked_advantage_ids` / `linked_principle_ids` 是存在库里的裸 ID 列表，
    如果只按 id 查，别人把这些 ID 写进自己的回环就能读到你的资产。
    """
    advantage_ids = list(loop.linked_advantage_ids or [])
    principle_ids = list(loop.linked_principle_ids or [])

    advantages: list[Advantage] = []
    if advantage_ids:
        rows = await session.execute(
            select(Advantage).where(
                Advantage.id.in_(advantage_ids), Advantage.user_id == user_id
            )
        )
        advantages = list(rows.scalars().all())

    principles: list[Principle] = []
    if principle_ids:
        rows = await session.execute(
            select(Principle).where(
                Principle.id.in_(principle_ids), Principle.user_id == user_id
            )
        )
        principles = list(rows.scalars().all())

    return advantages, principles


async def filter_owned_ids(
    session: AsyncSession, model, ids: list[int] | None, user_id: int
) -> list[int]:
    """写入前的归属过滤：只保留确实属于该用户的 ID。

    用在「用户提交 linked_*_ids」的写路径上。读路径同样要过滤
    （见 `load_linked_assets`）—— 两道都要，因为历史数据里可能已经存了脏 ID。
    """
    wanted = [int(i) for i in (ids or [])]
    if not wanted:
        return []
    rows = await session.execute(
        select(model.id).where(model.id.in_(wanted), model.user_id == user_id)
    )
    owned = {row[0] for row in rows.all()}
    # 保持调用方给的顺序，去掉重复
    seen: set[int] = set()
    result: list[int] = []
    for i in wanted:
        if i in owned and i not in seen:
            seen.add(i)
            result.append(i)
    return result


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

    st = (await weakness_stats(session, [card.id])).get(card.id, Stats())
    drills = (await drill_counts(session, [card.id])).get(card.id, 0)
    plans = (await plan_counts(session, [card.id])).get(card.id, 0)
    trend = (await weakness_trends(session, [card.id])).get(card.id)

    return weakness_out(
        card,
        trigger_count=st.trigger_count,
        hold_count=st.hold_count,
        hold_rate=st.rate,
        plan_count=plans,
        drill_count=drills,
        trend=trend,
    )
