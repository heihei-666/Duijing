"""对镜 · 认证

方案 7.9：JWT + httpOnly Cookie，7 天过期。

注册策略（已与产品确认）：邀请码注册 + 邀请链接。
  · 首个注册用户自动成为管理员并拿到自己的邀请码（否则系统无法起步）
  · 之后必须凭有效邀请码注册
  · 环境变量 BOOTSTRAP_INVITE_CODE 可设置一个固定邀请码，方便自己人加入
  · ALLOW_OPEN_REGISTER=true 可临时开放自由注册
"""

from __future__ import annotations

import secrets

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
from app.services.guest import ensure_guest_budget_available
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


async def _real_user_count(session: AsyncSession) -> int:
    """**正式账号**数量 —— 不含访客。

    【为什么「第一个用户免邀请码」必须按这个数算】

    访客也是一条 `user` 记录。如果按总表计数，会出现一个很隐蔽的死锁：

       部署者打开自己的新站 → 先点了「免费试用」（建了 1 条访客记录）
       → 再去注册自己的管理员账号 → 后端认为「已经有用户了，需要邀请码」
       → 而他手上不可能有码，因为能发码的人还没注册。

    也就是说：**只要他先体验过，就把自己的引导入口堵死了。**
    所以「第一个账号」必须只数正式账号，访客不算。
    """
    return int(
        await session.scalar(select(func.count(User.id)).where(User.is_guest.is_(False))) or 0
    )


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


@router.get("/bootstrap")
async def bootstrap_status(session: AsyncSession = Depends(get_session)):
    """实例的初始化状态（公开，无需登录）。

    存在的意义：只有**第一个**用户能免邀请码注册，但前端原本硬性要求填写邀请码，
    于是部署者第一次打开自己的站点时，会看到「需要一个邀请码」——
    而他手上根本没有邀请码，因为能发邀请码的人还没注册。

    这个端点让注册页能如实告诉第一个人：「你是第一个，直接注册就行」。

    注意 `needs_first_user` 按**正式账号**算，访客不计入 ——
    否则部署者先点了一次「免费试用」，引导入口就会被自己堵死
    （见 `_real_user_count` 的说明）。
    """
    real = await _real_user_count(session)
    total = await _user_count(session)
    return {
        "needs_first_user": real == 0,
        "user_count": real,
        "guest_count": total - real,
        "open_register": settings.ALLOW_OPEN_REGISTER,
        "invite_required": real > 0 and not settings.ALLOW_OPEN_REGISTER,
    }


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

    is_first_user = (await _real_user_count(session)) == 0

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


@router.post("/guest", status_code=status.HTTP_201_CREATED)
async def create_guest(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
):
    """创建一个访客（临时用户），直接签发正常令牌。

    【为什么是「临时用户」而不是「可空的 user_id」】

    辩论、观察、复盘这些逻辑有 56 处依赖 `user.id`。把 user_id 改成可空，
    就要在每一处加判空分支，**漏一处就是线上 500**，而且这类错误只在
    访客路径上触发 —— 正常用户的测试永远发现不了。

    建一条 `is_guest=True` 的真实用户记录，现有逻辑**一行都不用改**。
    它看到的就是一个普通用户。

    【为什么密码是随机的】

    访客不需要能登录 —— 认领时会给它设上真实密码。
    在那之前用一个谁也猜不到的随机串，保证这个账号无法被登录。

    【为什么这里就要限流】

    虽然建访客本身不花 AI 钱，但不限制的话可以被刷出大量临时账号，
    把 7 天清理任务的负担和数据库撑大。AI 成本的上限在**发起辩论**那一步。

    【为什么还要在这里查全站预算】

    建账号不花钱，但**建了却用不了**是最糟的体验：用户看到「免费试用」、
    点进来、写好场景、点开始，才被告知「今日试用人次已满」。
    在门口拦下，他至少还能当场看到「请注册后继续」这句话。
    """
    enforce(
        login_limiter,
        f"guest:{client_ip(request)}",
        settings.GUEST_CREATE_PER_MIN,
        "创建访客过于频繁，请稍后再试",
    )

    # 全站预算打满时**连访客账号都不建**：否则用户会先拿到账号、
    # 走到开辩页、点了开始才被告知「今天试用人次已满」，白花三步。
    await ensure_guest_budget_available(session)

    # token_urlsafe 含 - 和 _，去掉后只留字母数字，避免用户名里出现奇怪字符
    suffix = secrets.token_urlsafe(16).replace("-", "").replace("_", "")[:16]
    guest = User(
        username=f"guest_{suffix}",
        # 随机密码：这个账号在认领之前不可登录
        password_hash=hash_password(secrets.token_urlsafe(32)),
        nickname="访客",
        is_admin=False,
        is_guest=True,
        invite_code=await _unique_invite_code(session),
    )
    session.add(guest)
    await session.flush()

    session.add(UserProfile(user_id=guest.id))
    await session.commit()
    await session.refresh(guest)

    token = create_access_token(guest.id, guest.username)
    set_auth_cookie(response, token)

    return {
        "user": _user_dict(guest),
        "token": token,
        "is_guest": True,
    }


class ClaimPayload(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    password: str = Field(..., max_length=128)
    nickname: str = Field("", max_length=64)
    invite_code: str = Field("", max_length=32)


@router.post("/claim")
async def claim_guest(
    payload: ClaimPayload,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """把当前访客账号「认领」成正式账号 —— **数据原地继承，不搬家**。

    【为什么是原地认领，而不是「新建账号 + 迁移数据」】

    迁移意味着要处理几十张表的外键、事务要么全成要么全败、中途失败还会
    留下两份半成品数据。而访客账号本来就是一条正常的 `user` 记录，
    它的辩论、观察、复盘全都挂在这个 id 上 —— **只要把 id 上的
    用户名密码补齐、把 is_guest 清掉，一切就绪**。

    这也正是「访客 = 临时用户」这个设计最大的好处：**转化路径上没有数据搬迁**。

    【认领也要邀请码 —— 这一条曾经漏了】

    早期实现里认领不校验邀请码，于是「辩完一场 → 点保存」就能拿到正式账号：
    **邀请制事实上变成了开放注册**，而且认领后的账号没有每日 AI 上限。
    现在认领与注册走同一条门禁（`ALLOW_OPEN_REGISTER` / 邀请码 / 邀请人归属），
    唯一的例外是「实例上还没有任何正式账号」——那时认领的人就是第一个管理员，
    与 `/auth/register` 的语义一致（否则新部署的实例会没有管理员）。

    【为什么要在认领时重新签发令牌】

    JWT 里带着 username。改名之后旧令牌里的 username 就过期了，
    不重签会出现「令牌里的用户名和库里不一致」的隐性不一致。
    """
    if not user.is_guest:
        raise HTTPException(status_code=400, detail="当前账号不是访客账号，无需认领")

    username = payload.username.strip()
    if (error := validate_username(username)) is not None:
        raise HTTPException(status_code=400, detail=error)
    if (error := validate_password_strength(payload.password)) is not None:
        raise HTTPException(status_code=400, detail=error)

    existing = await session.scalar(select(User).where(User.username == username))
    if existing is not None:
        raise HTTPException(status_code=409, detail="用户名已被占用")

    is_first_real_user = (await _real_user_count(session)) == 0

    inviter: User | None = None
    if not is_first_real_user and not settings.ALLOW_OPEN_REGISTER:
        supplied = payload.invite_code.strip().upper()
        if not supplied:
            raise HTTPException(
                status_code=400,
                detail=(
                    "注册需要邀请码。向给你这个链接的人要一个，"
                    "拿到后回到这场辩论里就能保存。"
                ),
            )
        inviter = await _validate_invite(session, supplied)
        if inviter is None and supplied != settings.BOOTSTRAP_INVITE_CODE:
            raise HTTPException(status_code=400, detail="邀请码无效")

    user.username = username
    user.password_hash = hash_password(payload.password)
    user.nickname = payload.nickname.strip() or username
    user.is_guest = False
    # 归属到邀请人名下：邀请人的「已邀请人数」是靠统计 invited_by 得来的，
    # 不写这一笔，他发的码就永远显示「用过 0 次」。
    if inviter is not None:
        user.invited_by = inviter.id
    # 实例上的第一个正式账号自动成为管理员（与 /auth/register 保持一致）。
    # 不这么做的话，一个只会从落地页体验进来的新实例将永远没有管理员。
    if is_first_real_user:
        user.is_admin = True
    await session.commit()
    await session.refresh(user)

    token = create_access_token(user.id, user.username)
    set_auth_cookie(response, token)

    return {"user": _user_dict(user), "token": token, "is_first_user": is_first_real_user}


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
