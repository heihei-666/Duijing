"""对镜 · 好友（方案 3.10）

【这个文件的全部意义：把「好友能看到什么」收在一处】

好友功能最容易出事的地方不是增删改查，是**隐私边界慢慢被磨掉**：
今天有人想在好友列表加个「他在练什么弱点」，明天想加个撑住率，
后天想加个最近动态。每一次看起来都只是加一个字段。

所以这里有一条硬规则，**写代码时必须遵守**：

    `friend_progress()` 是好友能看到的**唯一**数据出口，
    而它返回的字段是**硬编码**的，不是从 User/WeaknessCard 上
    `__dict__` 拷过来的。

方案 3.10 用的是**白名单**而不是黑名单，理由也在那儿写着：
黑名单靠列举「不能分享的东西」，而每新增一张表或一个字段，
黑名单就自动漏一个，且不会有人发现。白名单只列允许项，
新增字段默认不可见 —— 它只会越用越安全。

所以：**要往好友可见范围加东西，必须先改方案 3.10**，
然后才会有人在这个文件里看到白名单并意识到自己在做什么。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DebateInvitationStatus,
    FriendRequest,
    FriendRequestStatus,
    Friendship,
    User,
    UserProfile,
)


class FriendError(Exception):
    """好友相关的业务错误。API 层负责翻成 HTTP 状态码与中文提示。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ── 关系查询 ────────────────────────────────────────────────


async def are_friends(session: AsyncSession, a: int, b: int) -> bool:
    """一次等值查询。这是规范化存储（low < high）换来的好处。"""
    if a == b:
        return False
    low, high = Friendship.order(a, b)
    row = await session.scalar(
        select(Friendship.id).where(
            Friendship.user_low_id == low, Friendship.user_high_id == high
        )
    )
    return row is not None


async def _friend_ids(session: AsyncSession, user_id: int) -> list[int]:
    """我的全部好友 id。"""
    rows = await session.execute(
        select(Friendship.user_low_id, Friendship.user_high_id).where(
            or_(Friendship.user_low_id == user_id, Friendship.user_high_id == user_id)
        )
    )
    ids: list[int] = []
    for low, high in rows.all():
        ids.append(high if low == user_id else low)
    return ids


async def _add_friendship(session: AsyncSession, a: int, b: int) -> None:
    low, high = Friendship.order(a, b)
    exists = await session.scalar(
        select(Friendship.id).where(
            Friendship.user_low_id == low, Friendship.user_high_id == high
        )
    )
    if exists is None:
        session.add(Friendship(user_low_id=low, user_high_id=high))
        await session.flush()


async def remove_friend(session: AsyncSession, user_id: int, other_id: int) -> None:
    """删除好友。删完**同时清掉旧申请记录**，否则对方会因为
    「之前拒绝过 / 之前申请过」而被永久挡住，再也加不回来。"""
    low, high = Friendship.order(user_id, other_id)
    friend = await session.scalar(
        select(Friendship).where(
            Friendship.user_low_id == low, Friendship.user_high_id == high
        )
    )
    if friend is None:
        raise FriendError("not_friends", "你们不是好友")
    await session.delete(friend)

    # 双向的申请记录一并清掉（含 rejected），让「删除」成为一个真正的重新开始
    old = await session.scalars(
        select(FriendRequest).where(
            or_(
                and_(
                    FriendRequest.from_user_id == user_id,
                    FriendRequest.to_user_id == other_id,
                ),
                and_(
                    FriendRequest.from_user_id == other_id,
                    FriendRequest.to_user_id == user_id,
                ),
            )
        )
    )
    for row in old.all():
        await session.delete(row)
    await session.flush()


# ── 申请 ────────────────────────────────────────────────────


async def find_user_by_username(session: AsyncSession, username: str) -> User | None:
    """按用户名**精确**匹配（方案 3.10：不做模糊搜索、不提供用户列表）。

    模糊搜索 + 用户列表等于提供了一个「浏览全站用户」的入口，
    而这个产品里每个人都存着私密的弱点数据 —— 不该有这种入口。
    """
    return await session.scalar(select(User).where(User.username == username))


async def send_request(session: AsyncSession, me: User, username: str) -> FriendRequest:
    username = (username or "").strip()
    if not username:
        raise FriendError("empty_username", "请输入用户名")

    target = await find_user_by_username(session, username)
    if target is None or target.id == me.id:
        # 不区分「不存在」和「是你自己」之外的信息，也不回显对方是否存在
        raise FriendError("user_not_found", "找不到这个用户")

    if await are_friends(session, me.id, target.id):
        raise FriendError("already_friends", "你们已经是好友了")

    # 对方已经申请过我 → 直接互加，不必让两边各按一次
    incoming = await session.scalar(
        select(FriendRequest).where(
            FriendRequest.from_user_id == target.id,
            FriendRequest.to_user_id == me.id,
            FriendRequest.status == FriendRequestStatus.PENDING.value,
        )
    )
    if incoming is not None:
        await respond(session, me, incoming.id, accept=True)
        return incoming

    # 我申请过但被拒了 → 拒绝是终态（方案 3.10 防骚扰）
    rejected = await session.scalar(
        select(FriendRequest).where(
            FriendRequest.from_user_id == me.id,
            FriendRequest.to_user_id == target.id,
            FriendRequest.status == FriendRequestStatus.REJECTED.value,
        )
    )
    if rejected is not None:
        raise FriendError("request_rejected", "对方已拒绝过你的申请")

    existing = await session.scalar(
        select(FriendRequest).where(
            FriendRequest.from_user_id == me.id,
            FriendRequest.to_user_id == target.id,
        )
    )
    if existing is not None:
        if existing.status == FriendRequestStatus.PENDING.value:
            raise FriendError("request_pending", "申请已发出，等待对方处理")
        # 极少数情况：accepted 但 friendship 行丢了（历史脏数据）→ 补上
        await _add_friendship(session, me.id, target.id)
        return existing

    request = FriendRequest(from_user_id=me.id, to_user_id=target.id)
    session.add(request)
    await session.flush()
    return request


async def respond(
    session: AsyncSession, me: User, request_id: int, *, accept: bool
) -> FriendRequest:
    request = await session.get(FriendRequest, request_id)
    # 只有**收件人**能处理，且只有 pending 能处理
    if request is None or request.to_user_id != me.id:
        raise FriendError("request_not_found", "申请不存在")
    if request.status != FriendRequestStatus.PENDING.value:
        raise FriendError("request_handled", "这条申请已经处理过了")

    from app.models import utcnow

    request.status = (
        FriendRequestStatus.ACCEPTED.value if accept else FriendRequestStatus.REJECTED.value
    )
    request.responded_at = utcnow()
    if accept:
        await _add_friendship(session, request.from_user_id, request.to_user_id)
    await session.flush()
    return request


async def list_requests(session: AsyncSession, user_id: int) -> tuple[list[dict], list[dict]]:
    """返回 (我收到的待处理, 我发出的待处理)。"""
    incoming = await session.execute(
        select(FriendRequest, User)
        .join(User, User.id == FriendRequest.from_user_id)
        .where(
            FriendRequest.to_user_id == user_id,
            FriendRequest.status == FriendRequestStatus.PENDING.value,
        )
        .order_by(FriendRequest.created_at.desc())
    )
    outgoing = await session.execute(
        select(FriendRequest, User)
        .join(User, User.id == FriendRequest.to_user_id)
        .where(
            FriendRequest.from_user_id == user_id,
            FriendRequest.status == FriendRequestStatus.PENDING.value,
        )
        .order_by(FriendRequest.created_at.desc())
    )

    def pack(rows) -> list[dict]:
        return [
            {
                "id": req.id,
                "user_id": other.id,
                "username": other.username,
                "nickname": other.nickname or other.username,
                "created_at": req.created_at,
            }
            for req, other in rows.all()
        ]

    return pack(incoming), pack(outgoing)


# ── 好友列表与「非敏感进展」白名单 ───────────────────────────


@dataclass
class FriendProgress:
    """好友能看到的东西 —— **只有这些**。

    两个字段都是**计数，不是内容**：连续天数说明「他在坚持」，
    但说不出「他在跟什么问题较劲」。这是方案 3.10 刻意选的。
    """

    streak_days: int
    practiced_today: bool


async def friend_progress(
    session: AsyncSession, friend_ids: list[int]
) -> dict[int, FriendProgress | None]:
    """按白名单取好友进展。

    **这是好友数据的唯一出口。** 返回 None 表示对方未开启分享 ——
    此时**不返回任何过期数据**（方案 3.10：关闭立即生效）。

    实现上刻意不复用 `build_status_bar()`：那个函数是为「我自己看」
    设计的，它会返回今天练什么、AI 观察到什么。一旦有人图省事
    改成复用它，弱点名称就会顺着这个函数流到好友那里。
    """
    if not friend_ids:
        return {}

    from app.services.status import compute_streak, get_today_loops

    rows = await session.execute(
        select(UserProfile.user_id, UserProfile.share_progress_with_friends).where(
            UserProfile.user_id.in_(friend_ids)
        )
    )
    sharing = {uid: bool(flag) for uid, flag in rows.all()}

    out: dict[int, FriendProgress | None] = {}
    for fid in friend_ids:
        if not sharing.get(fid, False):
            # 未开启 → 明确地什么都不给
            out[fid] = None
            continue
        streak = await compute_streak(session, fid)
        loops = await get_today_loops(session, fid)
        out[fid] = FriendProgress(streak_days=streak, practiced_today=bool(loops))
    return out


async def list_friends(session: AsyncSession, me: User) -> list[dict]:
    ids = await _friend_ids(session, me.id)
    if not ids:
        return []

    users = (await session.scalars(select(User).where(User.id.in_(ids)))).all()
    progress = await friend_progress(session, ids)

    items = []
    for user in users:
        p = progress.get(user.id)
        items.append(
            {
                "user_id": user.id,
                "username": user.username,
                # 昵称可以给：它是用户自己填的展示名，不是弱点数据
                "nickname": user.nickname or user.username,
                "sharing": p is not None,
                # 未开启分享时这两个字段**不返回**（而不是返回 0 / False，
                # 那会被误读成「他连着 0 天」）
                "streak_days": p.streak_days if p else None,
                "practiced_today": p.practiced_today if p else None,
            }
        )
    items.sort(key=lambda x: x["nickname"])
    return items


__all__ = [
    "FriendError",
    "FriendProgress",
    "are_friends",
    "find_user_by_username",
    "friend_progress",
    "list_friends",
    "list_requests",
    "remove_friend",
    "respond",
    "send_request",
    "DebateInvitationStatus",
]
