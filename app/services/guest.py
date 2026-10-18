"""访客模式的成本上限。

访客会**真实消耗 AI 额度**，而开放的是匿名接口 —— 不做限制就是把钱包挂在公网上。

三道上限，缺一不可：

  1. **单个访客每天次数** —— 查数据库，重启不丢。
  2. **单个 IP 每天次数** —— 单独算一遍，因为访客身份存在浏览器里，
     **清一下缓存就能换一个访客 ID**。只按访客 ID 限等于没限。
  3. **全站每天总次数** —— 防的是换 IP。前两道都能被绕过，这道是兜底。

【已知限制，不掩饰】

第 2 道是**内存计数**，进程重启会清零。要持久化得给访客加一列
`created_ip` 再按 IP 聚合查询 —— 那是一次 schema 变更，本轮没做。
重启不频繁，且第 1、3 道是数据库计数不受影响，所以实际风险可控。
**但这是设计上的缺口，不是「已经完备」。**
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import DebateRoom, User
from app.services.ratelimit import client_ip

# IP → (日期, 次数)。进程内内存，重启清零（见模块 docstring 的已知限制）
_ip_daily: dict[str, tuple[str, int]] = {}


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _start_of_today():
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _bump_ip(ip: str) -> int:
    today = _today()
    day, count = _ip_daily.get(ip, (today, 0))
    if day != today:  # 跨天了，重新开始
        count = 0
    count += 1
    _ip_daily[ip] = (today, count)
    return count


async def guest_debates_today(session: AsyncSession) -> int:
    """今天全站访客一共发起了多少场辩论。

    这是「全站预算」的唯一计量口径，`create_guest` 和 `enforce_guest_debate_quota`
    都读它 —— 两处各写一遍 SQL 的话，将来改口径（比如把「暂停后继续」也算进去）
    必然漏改一处，而漏掉的那处会让预算统计悄悄失真。
    """
    return (
        await session.scalar(
            select(func.count(DebateRoom.id))
            .join(User, User.id == DebateRoom.user_id)
            .where(
                User.is_guest.is_(True),
                DebateRoom.created_at >= _start_of_today(),
            )
        )
    ) or 0


async def ensure_guest_budget_available(session: AsyncSession) -> None:
    """全站预算已满时，**连访客账号都不再创建**。

    【为什么创建账号时也要查一次预算】

    只在「发起辩论」那一步拦，结果是：用户点「免费试用」→ 账号建好了 →
    进了开辩页 → 点开始 → 才被告知「今日试用人次已满」。
    他走完了所有步骤才撞墙，而账单上多了一个永远不会用的临时账号。

    在门口就告诉他和在第三步才告诉他，是两种完全不同体验；
    而在这里拦的成本只是一次数据库 count。

    【它不替代发起辩论时的那道检查】

    这里只是**提前失败**，真正的硬上限仍然在 `enforce_guest_debate_quota`
    的第 ③ 道 —— 创建和发起之间有窗口，那道才是记账的地方。
    """
    if await guest_debates_today(session) >= settings.GUEST_DAILY_BUDGET:
        raise HTTPException(
            status_code=429,
            detail="今日试用人次已满，请注册后继续。",
        )


async def enforce_guest_debate_quota(
    session: AsyncSession,
    user: User,
    request: Request,
) -> None:
    """访客发起辩论前的配额检查。**非访客直接放行，零开销。**

    顺序是刻意的：先查最便宜的（内存），再查数据库。
    不过这里三道都很快，顺序影响不大 —— 真正的理由是**报错文案**：
    命中单人限制时告诉用户「注册后继续」，这本来就是转化点。
    """
    if not user.is_guest:
        return

    today_start = _start_of_today()

    # ── ① 单个访客每天次数（数据库，准确）───────────────
    mine = await session.scalar(
        select(func.count(DebateRoom.id)).where(
            DebateRoom.user_id == user.id,
            DebateRoom.created_at >= today_start,
        )
    ) or 0
    if mine >= settings.GUEST_DEBATES_PER_DAY:
        raise HTTPException(
            status_code=403,
            detail=(
                f"访客每天可以免费体验 {settings.GUEST_DEBATES_PER_DAY} 次辩论，今天已用完。"
                "注册后可以无限使用，并且这次的观察会保存下来。"
            ),
        )

    # ── ② 单个 IP 每天次数（内存，重启清零）──────────────
    ip = client_ip(request)
    used = _bump_ip(ip)
    if used > settings.GUEST_DEBATES_PER_DAY:
        raise HTTPException(
            status_code=403,
            detail=(
                f"这个网络今天已经体验过 {settings.GUEST_DEBATES_PER_DAY} 次了。"
                "注册后可以继续，不受此限制。"
            ),
        )

    # ── ③ 全站每天总次数（数据库，兜底）───────────────────
    if await guest_debates_today(session) >= settings.GUEST_DAILY_BUDGET:
        raise HTTPException(
            status_code=429,
            detail="今日试用人次已满，请注册后继续。",
        )


def reset_ip_buckets() -> None:
    """清空 IP 计数。只给测试用 —— 生产不要调。"""
    _ip_daily.clear()
