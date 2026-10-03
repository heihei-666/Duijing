"""对镜 · AI 延迟队列的消费者

【这张表此前是「假队列」】

任务能进队（`event_cards.enqueue`），但**没有消费者**：
周扫描不看 `task_type` / `payload_json`，而是自己重新查一遍要处理什么，
然后把**所有** pending 行无条件标成 `done`。
`processing` / `failed` / `error` 三个字段从未被写过，行也永不清理。

所以真实执行是「定时任务全表扫一遍」，队列只是一张流水账。
面试里被问「你的夜间批处理失败了怎么办、幂等吗、积压怎么发现」时，
这张表一个都答不上来。

这个模块把它做成真队列：**认领 → 执行 → 成功 / 重试 / 失败**。

四个必须做对的地方：

  1. **幂等**：每条任务重复执行的结果必须和执行一次一样。
     典型场景是用户先点了「立即分析」（手动路径），队列里的同一条任务
     稍后仍会跑到 —— 此时卡片已经 `analyzed`，直接算成功跳过。
  2. **失败可重试、且重试有上限**：失败的先放回 pending，达到上限才置 failed。
     一条永远失败的任务不该无限占着队列，也不该静默消失。
  3. **陈旧 processing 回收**：进程在任务执行到一半时被重启/杀掉，
     行会永远停在 `processing`。没有这一步，队列会随时间慢慢"漏"任务，
     而且**没有任何迹象**。
  4. **只记成功的次数没有意义**：必须能看出「重试了几次」「失败了几条」
     「最老的一条等了多久」—— 否则「积压」是个无法回答的问题。
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AIQueue, QueueStatus
from app.utils import now_utc

logger = logging.getLogger("duijing.ai_queue")


class PermanentTaskError(RuntimeError):
    """**重试没有意义**的失败。

    必须和「模型暂时不可用」区分开：后者等一会儿再试就好了，
    前者比如载荷损坏、归属不符 —— 试一百次也是同一个结果，
    只会白烧三次模型调用，还让失败晚几天才浮出水面。

    处理器抛这个类型时，任务立刻置 failed，不走重试。
    """


# 任务类型。新增类型时必须同时在 HANDLERS 里注册，
# 否则进队的任务会在执行时被判为「未知任务类型」并直接置 failed。
TASK_ANALYZE_EVENT_CARD = "analyze_event_card"
KNOWN_TASKS = frozenset({TASK_ANALYZE_EVENT_CARD})

# 同一任务最多尝试几次（含首次）。超过就置 failed 并留下 error。
MAX_ATTEMPTS = 3

# processing 超过这个时长就认为执行它的进程已经死了
STALE_PROCESSING_MINUTES = 15

# 单次最多处理多少条 —— 夜间批处理不该因为队列积压而长时间占着数据库连接
DEFAULT_BATCH = 50


# ─────────────────────────────────────────────────────────────
# 单条任务的处理
# ─────────────────────────────────────────────────────────────


async def _handle_analyze_event_card(session: AsyncSession, task: AIQueue) -> str:
    """用 AI 判定一张事件卡的关联回环与结果。

    返回值是一句人类可读的执行说明，会记进日志便于排查。
    """
    from app.models import EventCard
    from app.services import event_cards as event_card_service

    payload = task.payload_json or {}
    card_id = payload.get("card_id")
    if not isinstance(card_id, int):
        # 载荷本身坏了 —— 重试多少次都一样
        raise PermanentTaskError(f"payload 缺少合法的 card_id：{payload!r}")

    card = await session.get(EventCard, card_id)
    if card is None:
        # 幂等：目标已经不在了（用户删了卡）算成功，不是错误
        return "卡片不存在，跳过"

    if card.user_id != task.user_id:
        # 不该发生：进队时是同一个人。真出现了说明有 bug，记失败便于发现
        raise PermanentTaskError(
            f"卡片 #{card_id} 不属于任务所有者 user={task.user_id}"
        )

    if card.analyzed:
        # 幂等的关键分支：用户点过「立即分析」，或上一次重试其实已经成功了
        return "卡片已分析过，跳过"

    result = await event_card_service.analyze_card(session, card)
    return f"已分析，结果={result.get('result')}"


HANDLERS = {
    TASK_ANALYZE_EVENT_CARD: _handle_analyze_event_card,
}


# ─────────────────────────────────────────────────────────────
# 队列推进
# ─────────────────────────────────────────────────────────────


async def recover_stale(session: AsyncSession) -> int:
    """把卡在 processing 太久的行放回队列。

    这是「进程执行到一半挂了」的唯一补救。没有它，那些行会永远是
    processing，既不会被重试，也不会出现在 pending 计数里。
    """
    cutoff = now_utc() - timedelta(minutes=STALE_PROCESSING_MINUTES)
    rows = await session.execute(
        select(AIQueue).where(
            AIQueue.status == QueueStatus.PROCESSING.value,
            # started_at 为空的 processing 行不可能是「正在执行」，一并回收
            or_(AIQueue.started_at.is_(None), AIQueue.started_at <= cutoff),
        )
    )
    recovered = 0
    for task in rows.scalars().all():
        attempts = task.attempts or 0
        if attempts >= MAX_ATTEMPTS:
            task.status = QueueStatus.FAILED.value
            task.processed_at = now_utc()
        else:
            task.status = QueueStatus.PENDING.value
        task.error = "任务执行中途被中断（进程重启），已回收"
        task.started_at = None
        recovered += 1

    if recovered:
        await session.flush()
        logger.warning("回收了 %s 条卡在 processing 的队列任务", recovered)
    return recovered


async def claim(session: AsyncSession, limit: int = DEFAULT_BATCH) -> list[AIQueue]:
    """取一批 pending 并标记为 processing。

    单 worker（`--workers 1`）下不需要锁；真要多进程时，
    这里要换成 `UPDATE ... WHERE status='pending' RETURNING` 之类的原子认领。
    """
    rows = await session.execute(
        select(AIQueue)
        .where(AIQueue.status == QueueStatus.PENDING.value)
        .order_by(AIQueue.created_at.asc(), AIQueue.id.asc())
        .limit(limit)
    )
    tasks = list(rows.scalars().all())

    now = now_utc()
    for task in tasks:
        task.status = QueueStatus.PROCESSING.value
        task.started_at = now
    if tasks:
        await session.flush()
    return tasks


async def process_pending(session: AsyncSession, limit: int = DEFAULT_BATCH) -> dict:
    """推进队列一次：回收陈旧行 → 认领 → 逐条执行。

    每条任务用 SAVEPOINT 包住：某一条失败时回滚它的副作用，
    **不影响同一批里其他任务**，也不会把整批已认领的状态一起 rollback 掉。
    """
    stats = {
        "recovered": await recover_stale(session),
        "claimed": 0,
        "done": 0,
        "retried": 0,
        "failed": 0,
        "unknown_task_type": 0,
    }

    tasks = await claim(session, limit=limit)
    stats["claimed"] = len(tasks)

    for task in tasks:
        handler = HANDLERS.get(task.task_type)
        if handler is None:
            # 未知类型重试也没用，直接失败并留下痕迹
            task.status = QueueStatus.FAILED.value
            task.processed_at = now_utc()
            task.error = f"未知任务类型：{task.task_type}"
            await session.flush()
            stats["unknown_task_type"] += 1
            stats["failed"] += 1
            logger.error("队列任务 #%s 类型未知：%s", task.id, task.task_type)
            continue

        try:
            async with session.begin_nested():
                note = await handler(session, task)
                task.status = QueueStatus.DONE.value
                task.processed_at = now_utc()
                task.error = None
            stats["done"] += 1
            logger.info("队列任务 #%s(%s) 完成：%s", task.id, task.task_type, note)
        except Exception as exc:  # noqa: BLE001
            # savepoint 已经把 handler 的副作用回滚了，这里只处理任务本身的状态
            attempts = (task.attempts or 0) + 1
            task.attempts = attempts
            task.error = str(exc)[:500]
            task.started_at = None

            # 永久性失败不重试：试一百次也是同一个结果，只会白烧模型调用，
            # 还让问题晚几天才浮出水面。
            permanent = isinstance(exc, PermanentTaskError)

            if permanent or attempts >= MAX_ATTEMPTS:
                task.status = QueueStatus.FAILED.value
                task.processed_at = now_utc()
                stats["failed"] += 1
                logger.error(
                    "队列任务 #%s(%s) 失败（%s）：%s",
                    task.id,
                    task.task_type,
                    "不可重试" if permanent else f"重试 {attempts} 次后",
                    exc,
                )
            else:
                task.status = QueueStatus.PENDING.value
                stats["retried"] += 1
                logger.warning(
                    "队列任务 #%s(%s) 第 %s 次失败，稍后重试：%s",
                    task.id, task.task_type, attempts, exc,
                )
            await session.flush()

    return stats


async def process_pending_in_new_session(limit: int = DEFAULT_BATCH) -> dict:
    """给定时任务用的入口：自己开 session、自己吞异常。

    队列推进失败不该让调度器收到异常（那会触发 APScheduler 的告警路径），
    但**必须**留下日志 —— 队列不动是最需要被发现的故障之一。
    """
    from app.db import session_scope

    try:
        async with session_scope() as session:
            return await process_pending(session, limit=limit)
    except Exception:  # noqa: BLE001
        logger.exception("队列推进失败")
        return {"error": "exception"}


async def backlog(session: AsyncSession) -> dict:
    """队列积压快照。回答「积压怎么发现」。

    `/api/admin/ai-stats` 会带上它 —— 没有这个，队列堆积只能靠人肉发现。
    """
    from sqlalchemy import func

    rows = await session.execute(
        select(AIQueue.status, func.count(AIQueue.id)).group_by(AIQueue.status)
    )
    by_status = {status: int(count) for status, count in rows.all()}

    oldest = await session.scalar(
        select(func.min(AIQueue.created_at)).where(
            AIQueue.status.in_(
                [QueueStatus.PENDING.value, QueueStatus.PROCESSING.value]
            )
        )
    )

    oldest_age_seconds = None
    if oldest is not None:
        oldest_age_seconds = int((now_utc() - oldest).total_seconds())

    failed_recent = await session.scalar(
        select(func.count(AIQueue.id)).where(
            AIQueue.status == QueueStatus.FAILED.value,
            AIQueue.processed_at.is_not(None),
            AIQueue.processed_at >= now_utc() - timedelta(days=7),
        )
    )

    return {
        "by_status": by_status,
        "pending": by_status.get(QueueStatus.PENDING.value, 0),
        "processing": by_status.get(QueueStatus.PROCESSING.value, 0),
        "failed": by_status.get(QueueStatus.FAILED.value, 0),
        "failed_last_7d": int(failed_recent or 0),
        # 最老的一条待办等了多久 —— 积压的直接信号
        "oldest_pending_age_seconds": oldest_age_seconds,
        "max_attempts": MAX_ATTEMPTS,
        "stale_processing_minutes": STALE_PROCESSING_MINUTES,
    }
