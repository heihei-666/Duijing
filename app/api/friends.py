"""对镜 · 好友 API（方案 3.10）

【安全要点，改这个文件前先读】

1. **搜索是精确匹配**，不提供模糊搜索。模糊搜索等于提供了一个
   「浏览全站用户」的入口，而这个产品里每个人都存着私密的弱点数据。
2. **好友列表只返回白名单字段**（连续天数 / 今天是否练过），
   且对方未开启分享时这两个字段返回 null —— 不是 0、不是 False，
   否则前端会把它显示成「他连着 0 天」。
3. **所有归属校验贴在查询条件里**，不是查出来再比。
   处理申请时校验 `to_user_id == me.id`，删除好友只按自己的 id 归一化。
   这个项目之前出过四条越权路径，全部是「查出来再判断」导致的。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.services import friends as friend_service
from app.services.friends import FriendError

router = APIRouter(prefix="/api/friends", tags=["好友"])

# 业务错误码 → HTTP 状态码。
# 409 用于「状态冲突」（已经是好友了 / 申请已发出），403 用于「被明确拒绝过」。
_STATUS = {
    "empty_username": 400,
    "user_not_found": 404,
    "already_friends": 409,
    "request_pending": 409,
    "request_rejected": 403,
    "request_not_found": 404,
    "request_handled": 409,
    "not_friends": 404,
}


def _fail(exc: FriendError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(exc.code, 400), detail=exc.message)


class FriendRequestBody(BaseModel):
    # 按用户名精确查找，所以字段名就叫 username（不是关键词）
    username: str


@router.get("")
async def list_friends(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """好友列表。

    返回里带 `sharing` 与两个可空字段；**方案 3.10 的白名单就是这里的两项**。
    要加字段，先改方案。
    """
    return {"friends": await friend_service.list_friends(session, user)}


@router.get("/search")
async def search_user(
    username: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """按用户名精确查找。

    刻意**不返回任何敏感字段**，也不回显邮箱/注册时间这类可用于画像的信息——
    只需要足够判断「是不是我要找的人」：id、用户名、昵称。
    """
    username = (username or "").strip()
    if not username:
        return {"found": False}

    target = await friend_service.find_user_by_username(session, username)
    if target is None or target.id == user.id:
        # 「不存在」和「是你自己」都不区分，避免这个接口变成探测工具
        return {"found": False}

    already = await friend_service.are_friends(session, user.id, target.id)
    return {
        "found": True,
        "already_friends": already,
        "user": {
            "user_id": target.id,
            "username": target.username,
            "nickname": target.nickname or target.username,
        },
    }


@router.get("/suggestions")
async def list_suggestions(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """用我的邀请码注册、但还不是好友的人（方案 3.10「邀请关系」）。

    只是**建议** —— 前端点「加好友」后仍走 `POST /friends/requests`，
    对方接受才成为好友。理由写在方案 3.10 与服务层 `invite_suggestions` 的注释里。
    """
    return {"suggestions": await friend_service.invite_suggestions(session, user)}


@router.get("/requests")
async def list_requests(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    incoming, outgoing = await friend_service.list_requests(session, user.id)
    return {"incoming": incoming, "outgoing": outgoing}


@router.post("/requests", status_code=201)
async def create_request(
    payload: FriendRequestBody,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        request = await friend_service.send_request(session, user, payload.username)
    except FriendError as exc:
        raise _fail(exc) from exc

    await session.commit()
    return {"id": request.id, "status": request.status}


@router.post("/requests/{request_id}/accept")
async def accept_request(
    request_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        request = await friend_service.respond(session, user, request_id, accept=True)
    except FriendError as exc:
        raise _fail(exc) from exc

    await session.commit()
    return {"id": request.id, "status": request.status}


@router.post("/requests/{request_id}/reject")
async def reject_request(
    request_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """拒绝。

    注意：拒绝是**终态**（方案 3.10）——申请行会保留为 rejected，
    对方不能再向你申请，除非你先删掉他。这是防骚扰的必要代价。
    """
    try:
        request = await friend_service.respond(session, user, request_id, accept=False)
    except FriendError as exc:
        raise _fail(exc) from exc

    await session.commit()
    return {"id": request.id, "status": request.status}


@router.delete("/{user_id}")
async def remove_friend(
    user_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """删除好友。会一并清掉双方的申请记录，让这次删除成为真正的重新开始。"""
    try:
        await friend_service.remove_friend(session, user.id, user_id)
    except FriendError as exc:
        raise _fail(exc) from exc

    await session.commit()
    return {"ok": True}
