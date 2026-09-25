"""对镜 · 依赖注入

认证走 httpOnly Cookie（方案 7.9），同时兼容 Authorization: Bearer，
方便脚本和移动端调用。
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import User, UserProfile
from app.security import decode_access_token


def extract_token(request: Request) -> str | None:
    """取认证令牌：**显式凭证优先于环境凭证**。

    先看 Authorization: Bearer，再看 httpOnly Cookie。

    为什么是这个顺序：浏览器只会带 Cookie，脚本和移动端只会带 Bearer，
    正常情况下两者不会同时出现。一旦同时出现且内容不同，说明调用方
    明确指定了身份，此时若让 Cookie 抢先，就会出现「我明明传了 A 的令牌，
    服务端却按 B 的身份处理」——这类问题极难排查，且在多账号场景下
    会直接造成越权读写。显式声明必须赢。
    """
    header = request.headers.get("Authorization") or ""
    if header.startswith("Bearer "):
        token = header[7:].strip()
        if token:
            return token

    return request.cookies.get(settings.COOKIE_NAME)


def set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.COOKIE_NAME,
        value=token,
        max_age=settings.JWT_EXPIRE_DAYS * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        domain=settings.COOKIE_DOMAIN,
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.COOKIE_NAME,
        domain=settings.COOKIE_DOMAIN,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
    )


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> User:
    token = extract_token(request)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录")

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态已失效，请重新登录")

    try:
        user_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态异常")

    user = await session.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    return user


async def get_optional_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> User | None:
    token = extract_token(request)
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    try:
        user_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        return None
    return await session.scalar(select(User).where(User.id == user_id))


async def ensure_profile(session: AsyncSession, user: User) -> UserProfile:
    """取用户偏好，没有就建一条默认的。"""
    profile = await session.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    if profile is None:
        profile = UserProfile(user_id=user.id)
        session.add(profile)
        await session.flush()
    return profile
