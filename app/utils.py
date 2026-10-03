"""对镜 · 通用工具

时间处理是这个系统的关键细节：数据库统一存 UTC，
但「今天」「连续天数」「近 30 天」全部按本地时区（默认 Asia/Shanghai）判定。
"""

from __future__ import annotations

import secrets
import string
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.config import settings

LOCAL_TZ = ZoneInfo(settings.TZ)

WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 邀请码字符集：去掉 0/O/1/I 等易混淆字符
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def local_now() -> datetime:
    """当前本地时间（带时区）。"""
    return datetime.now(LOCAL_TZ)


def local_today() -> date:
    """当前本地日期。所有「今天」的判定都用它。"""
    return local_now().date()


def to_utc(naive_or_aware: datetime) -> datetime:
    """把任意 datetime 归一成 UTC。"""
    if naive_or_aware.tzinfo is None:
        naive_or_aware = naive_or_aware.replace(tzinfo=timezone.utc)
    return naive_or_aware.astimezone(timezone.utc)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def local_day_start_utc(target: date) -> datetime:
    """某本地日期 00:00 对应的 UTC 时刻。"""
    return datetime.combine(target, datetime.min.time(), tzinfo=LOCAL_TZ).astimezone(timezone.utc)


def utc_to_local(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return to_utc(value).astimezone(LOCAL_TZ)


def iso_utc(value: datetime | None) -> str | None:
    """序列化成契约要求的 ISO 8601 UTC 字符串。"""
    if value is None:
        return None
    return to_utc(value).strftime("%Y-%m-%dT%H:%M:%SZ")


def weekday_cn(target: date) -> str:
    return WEEKDAY_CN[target.weekday()]


def days_since(value: datetime | None, *, reference: datetime | None = None) -> int:
    """距今天数（本地日历日差）。"""
    if value is None:
        return 0
    ref = reference or now_utc()
    return (utc_to_local(ref).date() - utc_to_local(value).date()).days


def generate_code(length: int = 8) -> str:
    """生成邀请码 / 邀请令牌。"""
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))


def generate_token(length: int = 24) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def hold_rate(hold: int, total: int) -> int | None:
    """撑住率百分比。**无触发数据时返回 None，不是 0。**

    这个区别至关重要：0% 的含义是「每次都破功」，而 None 的含义是
    「还没有数据」。把两者都渲染成 0%，会让刚建好回环的新用户
    一进门就看到 0% —— 那是在告诉他「你一直在失败」，
    而他其实一次都还没练过。

    方案 3.3：不用模糊分数，用「近 30 天撑住率」。
    """
    if total <= 0:
        return None
    return round(hold * 100 / total)


def rate_bucket(rate: int | None) -> str | None:
    """撑住率档位，与配色方案第四章一一对应。无数据返回 None。"""
    if rate is None:
        return None
    if rate < 40:
        return "low"  # #B85C5C 破功多，还在挣扎
    if rate < 60:
        return "mid"  # #C4944A 一半一半
    if rate < 80:
        return "good"  # #5B8C6B 在改善
    return "great"  # #4A8C5C 达标，可降级


def parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None
