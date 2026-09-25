"""对镜 · 认证

方案 7.9：JWT + httpOnly Cookie，7 天过期。

注册策略（已与产品确认）：邀请码注册 + 邀请链接。
  · 首个注册用户自动成为管理员并拿到自己的邀请码（否则系统无法起步）
  · 之后必须凭有效邀请码注册
  · 环境变量 BOOTSTRAP_INVITE_CODE 可设置一个固定邀请码，方便自己人加入
  · ALLOW_OPEN_REGISTER=true 可临时开放自由注册
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.deps import (
    clear_auth_cookie,
    ensure_profile,
    get_current_user,
    set_auth_cookie,
)
from app.models import User, UserProfile
from app.security import (
    create_access_token,
    hash_password,
    validate_password_strength,
    validate_username,
    verify_password,
)
from app.services.ratelimit import (
    client_ip,
    enforce,
    login_limiter,
    login_lockout,
)
from app.utils import generate_code

router = APIRouter(prefix="/api/auth", tags=["认证"])

_lockout = login_lockout(settings.LOGIN_LOCK_THRESHOLD, settings.LOGIN_LOCK_MINUTES)


# ── 请求体 ────────────────────────────────────────────────────


class RegisterPayload(BaseModel):
    username: str = Field(..., max_length=32)
    password: str = Field(..., max_length=128)
    nickname: str = Field("", max_length=64)
    invite_code: str = Field("", max_length=32)


class LoginPayload(BaseModel):
    username: str = Field(..., max_length=32)
    password: str = Field(..., max_length=128)


# ── 内部 ──────────────────────────────────────────────────────


async def _user_count(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count(User.id))) or 0)


async def _unique_invite_code(session: AsyncSession) -> str:
    for _ in range(10):
        code = generate_code(8)
        exists = await session.scalar(select(User.id).where(User.invite_code == code))
        if not exists:
            return code
    raise HTTPException(status_code=500, detail="邀请码生成失败，请重试")


async def _validate_invite(session: AsyncSession, code: str) -> User | None:
    """校验邀请码，返回邀请人（可能为 None）。"""
    code = (code or "").strip().upper()
    if not code:
        return None

    if settings.BOOTSTRAP_INVITE_CODE and code == settings.BOOTSTRAP_INVITE_CODE:
        return None

    return await session.scalar(select(User).where(User.invite_code == code))


def _auth_response(user: User) -> dict:
    return {"user": _user_dict(user), "token": create_access_token(user.id, user.username)}


def _user_dict(user: User) -> dict:
    from app.services.serializers import user_out

    return user_out(user)


# ── 接口 ──────────────────────────────────────────────────────


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterPayload,
    response: Response,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    enforce(login_limiter, f"register:{client_ip(request)}", settings.LOGIN_RATE_PER_MIN, "注册过于频繁")

    username = payload.username.strip()
    if (error := validate_username(username)) is not None:
        raise HTTPException(status_code=400, detail=error)
    if (error := validate_password_strength(payload.password)) is not None:
        raise HTTPException(status_code=400, detail=error)

    existing = await session.scalar(select(User).where(User.username == username))
    if existing is not None:
        raise HTTPException(status_code=409, detail="用户名已被占用")

    is_first_user = (await _user_count(session)) == 0

    inviter: User | None = None
    if not is_first_user and not settings.ALLOW_OPEN_REGISTER:
        supplied = payload.invite_code.strip().upper()
        if not supplied:
            raise HTTPException(status_code=400, detail="需要邀请码才能注册")
        inviter = await _validate_invite(session, supplied)
        if inviter is None and supplied != settings.BOOTSTRAP_INVITE_CODE:
            raise HTTPException(status_code=400, detail="邀请码无效")

    user = User(
        username=username,
        password_hash=hash_password(payload.password),
        nickname=payload.nickname.strip() or username,
        is_admin=is_first_user,
        invite_code=await _unique_invite_code(session),
        invited_by=inviter.id if inviter else None,
    )
    session.add(user)
    await session.flush()

    session.add(UserProfile(user_id=user.id))
    await session.commit()
    await session.refresh(user)

    token = create_access_token(user.id, user.username)
    set_auth_cookie(response, token)

    return {
        "user": _user_dict(user),
        "token": token,
        "is_first_user": is_first_user,
        "invite_code": user.invite_code,
    }


@router.post("/login")
async def login(
    payload: LoginPayload,
    response: Response,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    ip = client_ip(request)
    locked = _lockout.is_locked(ip)
    if locked:
        raise HTTPException(
            status_code=429,
            detail=f"失败次数过多，请 {locked // 60 + 1} 分钟后再试",
        )

    enforce(login_limiter, f"login:{ip}", settings.LOGIN_RATE_PER_MIN, "登录过于频繁")

    username = payload.username.strip()
    user = await session.scalar(select(User).where(User.username == username))

    if user is None or not verify_password(payload.password, user.password_hash):
        _lockout.record_failure(ip)
        # 不区分「用户不存在」和「密码错误」，避免账号枚举
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    _lockout.reset(ip)
    await ensure_profile(session, user)
    await session.commit()

    token = create_access_token(user.id, user.username)
    set_auth_cookie(response, token)
    return {"user": _user_dict(user), "token": token}


@router.post("/logout")
async def logout(response: Response):
    clear_auth_cookie(response)
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {"user": _user_dict(user)}


@router.get("/invite")
async def my_invite(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    used = int(
        await session.scalar(select(func.count(User.id)).where(User.invited_by == user.id)) or 0
    )
    base = str(request.base_url).rstrip("/")
    return {
        "code": user.invite_code,
        "link": f"{base}/join/{user.invite_code}",
        "used_count": used,
    }


@router.post("/invite/rotate")
async def rotate_invite(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """重置邀请码。旧码立即失效，已加入的用户不受影响。"""
    user.invite_code = await _unique_invite_code(session)
    await session.commit()
    return {"code": user.invite_code}
