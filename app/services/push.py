"""对镜 · Web Push 与辩论提醒

这是产品里**唯一的主动触达通道**。方案 3.9 写得很清楚：

    默认不推送。唯一例外：用户主动预约的辩论提醒。

这句话的分量在于：**推送权是用户借给我们的**，而且只借给他自己约的那个时间点。
所以这个模块的每一处设计都遵循一条原则——

    **只用它送用户自己约的那件事，绝不用来催事件卡、催演练、推活动。**

一旦哪天想「顺便提醒一下用户今天还没记录」，那就是在消耗这份信任，
而且消耗得很快。

技术选型：
  · Web Push（VAPID）+ Service Worker，不依赖第三方推送服务
  · 不用邮件：需要 SMTP 配置与发信域名备案，成本远高于收益
  · 不引入 Redis / Celery：APScheduler 每分钟扫一次待发提醒，
    在个人应用的数据量下完全够用，也少一个要维护的组件
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timedelta

from cryptography.hazmat.primitives import serialization
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pywebpush import WebPushException, webpush

from app.config import DATA_DIR
from app.models import DebateReminder, DebateRoom, PushSubscription
from app.utils import LOCAL_TZ, iso_utc, local_now, now_utc, to_utc

logger = logging.getLogger("duijing.push")

VAPID_PRIVATE_KEY_PATH = DATA_DIR / "vapid_private.pem"
# 推送服务返回这两个状态码表示订阅已失效（用户卸载了 PWA / 清了数据），
# 必须停止重试，否则会一直被推送服务拒绝。
GONE_STATUS_CODES = (404, 410)


# ─────────────────────────────────────────────────────────────
# VAPID 密钥
# ─────────────────────────────────────────────────────────────


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def ensure_vapid_keys() -> tuple[str, str]:
    """返回 (私钥 PEM, 公钥 base64url)。

    首次调用时生成并落盘。放在 data/ 下（已被 .gitignore 覆盖），
    绝不能进版本库——私钥泄露意味着任何人都能冒充本服务发推送。
    """
    from py_vapid import Vapid01

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if VAPID_PRIVATE_KEY_PATH.exists():
        pem = VAPID_PRIVATE_KEY_PATH.read_text(encoding="utf-8")
        vapid = Vapid01.from_pem(pem.encode("utf-8"))
    else:
        vapid = Vapid01()
        vapid.generate_keys()
        pem = vapid.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")
        VAPID_PRIVATE_KEY_PATH.write_text(pem, encoding="utf-8")
        try:
            os.chmod(VAPID_PRIVATE_KEY_PATH, 0o600)
        except OSError:
            pass
        logger.info("已生成 VAPID 密钥：%s", VAPID_PRIVATE_KEY_PATH)

    public_raw = vapid.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return pem, _b64url(public_raw)


_vapid_cache: tuple[str, str] | None = None


def vapid_keys() -> tuple[str, str] | None:
    """带缓存地取 VAPID 密钥。生成失败返回 None（推送功能整体降级，不影响其他功能）。"""
    global _vapid_cache
    if _vapid_cache is None:
        try:
            _vapid_cache = ensure_vapid_keys()
        except Exception:  # noqa: BLE001 - 推送是附加能力，不能拖垮主服务
            logger.exception("VAPID 密钥初始化失败，推送功能不可用")
            return None
    return _vapid_cache


def public_key() -> str | None:
    keys = vapid_keys()
    return keys[1] if keys else None


# ─────────────────────────────────────────────────────────────
# 订阅管理
# ─────────────────────────────────────────────────────────────


async def save_subscription(
    session: AsyncSession,
    *,
    user_id: int,
    endpoint: str,
    p256dh: str,
    auth: str,
    user_agent: str = "",
) -> PushSubscription:
    """保存或更新订阅。

    同一个 endpoint 重复订阅时**更新密钥**而不是新增：
    浏览器重新订阅会换掉 p256dh/auth，旧记录留着只会推送失败。
    """
    existing = await session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == endpoint)
    )
    if existing is not None:
        existing.user_id = user_id
        existing.p256dh = p256dh
        existing.auth = auth
        existing.user_agent = user_agent[:255]
        existing.failed_at = None
        await session.flush()
        return existing

    sub = PushSubscription(
        user_id=user_id,
        endpoint=endpoint,
        p256dh=p256dh,
        auth=auth,
        user_agent=user_agent[:255],
    )
    session.add(sub)
    await session.flush()
    return sub


async def remove_subscription(session: AsyncSession, *, user_id: int, endpoint: str) -> bool:
    sub = await session.scalar(
        select(PushSubscription).where(
            PushSubscription.user_id == user_id, PushSubscription.endpoint == endpoint
        )
    )
    if sub is None:
        return False
    await session.delete(sub)
    await session.flush()
    return True


async def active_subscriptions(session: AsyncSession, user_id: int) -> list[PushSubscription]:
    rows = await session.execute(
        select(PushSubscription).where(
            PushSubscription.user_id == user_id,
            PushSubscription.failed_at.is_(None),
        )
    )
    return list(rows.scalars().all())


async def device_count(session: AsyncSession, user_id: int) -> int:
    return len(await active_subscriptions(session, user_id))


# ─────────────────────────────────────────────────────────────
# 发送
# ─────────────────────────────────────────────────────────────


def _send_one(subscription: PushSubscription, payload: dict, private_pem: str) -> None:
    """同步发送单条推送。由调用方放到线程里跑。

    pywebpush 是同步库，直接在事件循环里调用会阻塞整个服务——
    而推送服务的响应时间不受我们控制。所以必须 to_thread。
    """
    webpush(
        subscription_info={
            "endpoint": subscription.endpoint,
            "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
        },
        data=json.dumps(payload, ensure_ascii=False),
        vapid_private_key=private_pem,
        vapid_claims={"sub": "mailto:push@duijing.xyz"},
        timeout=15,
    )


async def send_to_user(session: AsyncSession, *, user_id: int, payload: dict) -> int:
    """给用户的全部设备推送。返回成功条数。

    失败的订阅不会抛给调用方：推送是尽力而为的能力，
    一条推不出去不能影响主流程（比如提醒任务的整批处理）。
    """
    keys = vapid_keys()
    if keys is None:
        return 0
    private_pem, _ = keys

    subs = await active_subscriptions(session, user_id)
    if not subs:
        return 0

    sent = 0
    for sub in subs:
        try:
            await asyncio.to_thread(_send_one, sub, payload, private_pem)
            sub.last_used_at = now_utc()
            sent += 1
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in GONE_STATUS_CODES:
                sub.failed_at = now_utc()
                logger.info("订阅已失效，标记停用 user=%s status=%s", user_id, status)
            else:
                logger.warning("推送失败 user=%s status=%s err=%s", user_id, status, exc)
        except Exception:  # noqa: BLE001
            logger.exception("推送异常 user=%s", user_id)

    await session.flush()
    return sent


# ─────────────────────────────────────────────────────────────
# 提醒
# ─────────────────────────────────────────────────────────────


# 预设时间点。让用户点一下就行，不需要在手机上挑日期时间——
# 那是给「预约」这件事增加摩擦，而预约本身就是我们要降低的门槛。
REMINDER_PRESETS: dict[str, str] = {
    "in_30min": "30 分钟后",
    "in_1h": "1 小时后",
    "tonight_8": "今晚 8 点",
    "tomorrow_8": "明晚 8 点",
    "tomorrow_9am": "明天早上 9 点",
}


def resolve_preset(preset: str, *, reference: datetime | None = None) -> datetime | None:
    """把预设名解析成 UTC 时间点。"""
    now = reference or local_now()

    if preset == "in_30min":
        return to_utc(now + timedelta(minutes=30))
    if preset == "in_1h":
        return to_utc(now + timedelta(hours=1))

    def at_hour(day_offset: int, hour: int) -> datetime:
        target = (now + timedelta(days=day_offset)).replace(
            hour=hour, minute=0, second=0, microsecond=0
        )
        # 今天的目标时刻已经过了 → 顺延到明天
        if day_offset == 0 and target <= now:
            target += timedelta(days=1)
        return to_utc(target)

    if preset == "tonight_8":
        return at_hour(0, 20)
    if preset == "tomorrow_8":
        return at_hour(1, 20)
    if preset == "tomorrow_9am":
        return at_hour(1, 9)
    return None


async def upsert_reminder(
    session: AsyncSession,
    *,
    user_id: int,
    room_id: int,
    remind_at: datetime,
    note: str = "",
) -> DebateReminder:
    """设置提醒。同一场辩论只保留一条待发提醒，重复设置即覆盖。"""
    existing = await session.scalar(
        select(DebateReminder).where(
            DebateReminder.user_id == user_id,
            DebateReminder.room_id == room_id,
            DebateReminder.status == "pending",
        )
    )
    if existing is not None:
        existing.remind_at = remind_at
        existing.note = note[:120]
        existing.error = None
        await session.flush()
        return existing

    reminder = DebateReminder(
        user_id=user_id,
        room_id=room_id,
        remind_at=remind_at,
        note=note[:120],
    )
    session.add(reminder)
    await session.flush()
    return reminder


async def pending_reminder(
    session: AsyncSession, *, user_id: int, room_id: int
) -> DebateReminder | None:
    return await session.scalar(
        select(DebateReminder).where(
            DebateReminder.user_id == user_id,
            DebateReminder.room_id == room_id,
            DebateReminder.status == "pending",
        )
    )


async def cancel_reminder(session: AsyncSession, *, user_id: int, room_id: int) -> bool:
    reminder = await pending_reminder(session, user_id=user_id, room_id=room_id)
    if reminder is None:
        return False
    reminder.status = "cancelled"
    await session.flush()
    return True


async def dispatch_due_reminders(session: AsyncSession, *, limit: int = 50) -> dict:
    """发送所有到点的提醒。由定时任务每分钟调用一次。

    幂等：发送后立即把状态改成 sent，即使任务重叠执行也不会重复推送。
    """
    now = now_utc()
    rows = await session.execute(
        select(DebateReminder)
        .where(DebateReminder.status == "pending", DebateReminder.remind_at <= now)
        .order_by(DebateReminder.remind_at.asc())
        .limit(limit)
    )
    reminders = list(rows.scalars().all())

    stats = {"due": len(reminders), "sent": 0, "failed": 0, "no_device": 0}

    for reminder in reminders:
        room = await session.get(DebateRoom, reminder.room_id)
        topic = room.topic if room else "你预约的辩论"

        delivered = await send_to_user(
            session,
            user_id=reminder.user_id,
            payload={
                "title": "到点了",
                "body": f"你约的辩论：{topic}",
                "url": f"/debates/{reminder.room_id}",
                "tag": f"debate-{reminder.room_id}",
                # 用户自己约的，就该由他决定什么时候看
                "renotify": False,
            },
        )

        if delivered > 0:
            reminder.status = "sent"
            reminder.sent_at = now_utc()
            stats["sent"] += 1
        else:
            # 没有设备订阅：标记为失败并留下原因，不无限重试
            reminder.status = "failed"
            reminder.error = "没有可用的推送设备（用户未开启通知，或订阅已失效）"
            reminder.sent_at = now_utc()
            stats["failed"] += 1

    await session.flush()
    if stats["due"]:
        logger.info("提醒派发：%s", stats)
    return stats


async def reminder_out(reminder: DebateReminder | None, room_id: int) -> dict | None:
    if reminder is None:
        return None
    return {
        "id": reminder.id,
        "room_id": room_id,
        "remind_at": iso_utc(reminder.remind_at),
        "remind_at_local": to_utc(reminder.remind_at).astimezone(LOCAL_TZ).strftime("%m-%d %H:%M"),
        "status": reminder.status,
        "note": reminder.note,
    }
