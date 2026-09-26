"""对镜 · 定时任务

方案 5.4 的错峰策略：后台任务全部夜间执行。
方案 3.9 的通知策略：**默认不推送**，这里也刻意不做任何推送，
定时任务只落库，用户下次打开 App 才看到。
"""

from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.api.advantages import archive_stale
from app.config import settings
from app.db import session_scope
from app.services import event_cards as event_card_service
from app.services import loops as loop_service
from app.services import observations as observation_service
from app.services import push as push_service

logger = logging.getLogger("duijing.scheduler")

_scheduler: AsyncIOScheduler | None = None


# ── 任务体 ────────────────────────────────────────────────────


async def job_weekly_scan() -> None:
    """每周日 02:00：分析待处理事件卡 + 生成弱点候选（方案 3.4 / 5.4）。"""
    try:
        async with session_scope() as session:
            result = await event_card_service.run_weekly_scan(session)
        logger.info("周扫描完成：%s", result)
    except Exception:  # noqa: BLE001
        logger.exception("周扫描失败")


async def job_expire_observations() -> None:
    """每小时：把过了 24 小时的 AI 观察候选转成 expired。

    只处理已被看到过的候选——没被看到过的不该凭空消失。
    """
    try:
        async with session_scope() as session:
            count = await observation_service.expire_stale(session)
        if count:
            logger.info("过期 AI 观察候选 %s 条", count)
    except Exception:  # noqa: BLE001
        logger.exception("AI 观察过期任务失败")


async def job_dispatch_reminders() -> None:
    """每分钟检查一次到点的辩论提醒并推送。

    这是产品唯一的主动触达，所以宁可多扫一次（每分钟的空查询成本极低），
    也不要让它晚到——用户约了「今晚 8 点」，8 点 05 分才响就已经失信了。
    """
    try:
        async with session_scope() as session:
            stats = await push_service.dispatch_due_reminders(session)
        if stats.get("due"):
            logger.info("辩论提醒派发：%s", stats)
    except Exception:  # noqa: BLE001
        logger.exception("提醒派发任务失败")


async def job_archive_stale_advantages() -> None:
    """每天 03:30：待确认超 30 天的优势自动归档（方案 3.5）。"""
    try:
        async with session_scope() as session:
            count = await archive_stale(session, settings.ADVANTAGE_ARCHIVE_DAYS)
        if count:
            logger.info("自动归档优势 %s 条", count)
    except Exception:  # noqa: BLE001
        logger.exception("优势归档任务失败")


async def job_purge_weaknesses() -> None:
    """每天 03:00：物理删除超过 60 天倒计时的弱点（方案 3.8）。"""
    try:
        async with session_scope() as session:
            count = await loop_service.purge_expired_weaknesses(session)
        if count:
            logger.info("物理删除过期弱点 %s 条", count)
    except Exception:  # noqa: BLE001
        logger.exception("弱点清理任务失败")


# ── 调度器 ────────────────────────────────────────────────────


def start_scheduler() -> AsyncIOScheduler | None:
    global _scheduler
    if not settings.ENABLE_SCHEDULER:
        logger.info("定时任务已通过 ENABLE_SCHEDULER=false 关闭")
        return None

    if _scheduler is not None:
        return _scheduler

    scheduler = AsyncIOScheduler(timezone=settings.TZ)

    scheduler.add_job(
        job_weekly_scan,
        CronTrigger(day_of_week=settings.SCAN_CRON_DAY, hour=settings.SCAN_CRON_HOUR, minute=0),
        id="weekly_scan",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        job_dispatch_reminders,
        IntervalTrigger(minutes=1),
        id="dispatch_reminders",
        replace_existing=True,
        misfire_grace_time=120,
    )
    scheduler.add_job(
        job_expire_observations,
        IntervalTrigger(hours=1),
        id="expire_observations",
        replace_existing=True,
        misfire_grace_time=600,
    )
    scheduler.add_job(
        job_purge_weaknesses,
        CronTrigger(hour=3, minute=0),
        id="purge_weaknesses",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        job_archive_stale_advantages,
        CronTrigger(hour=3, minute=30),
        id="archive_advantages",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    scheduler.start()
    _scheduler = scheduler
    logger.info(
        "定时任务已启动：提醒派发=每分钟，周扫描=%s %02d:00，观察过期=每小时，清理=每日 03:00/03:30",
        settings.SCAN_CRON_DAY,
        settings.SCAN_CRON_HOUR,
    )
    return scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("定时任务已停止")
