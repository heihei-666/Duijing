"""对镜 · 账号数据 API

对应《个人信息保护法》里用户对自己数据的权利：
  · 可携带 —— 导出全部数据
  · 可删除 —— 申请注销

这两件事在产品上不产生任何「增长」，所以最容易被无限期推迟；
但它们决定了用户敢不敢把真实的弱点写进来。
一个不让你把数据拿走的工具，用户是不会对它说真话的。
"""

from __future__ import annotations

import logging
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import ensure_profile, get_current_user
from app.models import (
    Advantage,
    AIObservation,
    ArchiveRecord,
    DailyState,
    DebateMessage,
    DebateReminder,
    DebateReview,
    DebateRoom,
    EventCard,
    LoopLog,
    Principle,
    User,
    UserProfile,
    WeaknessCard,
    WeaknessLoop,
)
from app.utils import iso_utc, now_utc

logger = logging.getLogger("duijing.api.account")

router = APIRouter(prefix="/api/account", tags=["账号数据"])

# 方案 3.1 的「AI 风格按用户水平调节」只有三个档位
VALID_LEVELS = {"novice", "intermediate", "advanced"}


class ProfilePayload(BaseModel):
    """可改的用户偏好。

    ⚠️ 这个接口是**补上一条断掉的线**：在此之前 `user_profile.level`
    只在建档案时写过默认值 `novice`，全仓库没有第二处赋值，
    前端也从来没读过它 —— 于是「AI 风格按水平调节」（方案 3.1）虽然
    在提示词层实现了（`prompts._level_cn`），却永远停在「新手」档，
    是个够不着的开关。`notify_debate_reminder` / `auto_scan_event_cards`
    两列同样是死的。
    """

    level: str | None = Field(None, max_length=16)
    notify_debate_reminder: bool | None = None
    auto_scan_event_cards: bool | None = None
    # 方案 3.10：向好友分享今日进度（连续天数 + 今天是否练过）。
    #
    # ⚠️ 这个开关只控制**两项计数**，不控制任何内容。改它之前先读方案 3.10 ——
    # 好友可见范围是白名单，新增字段默认不可见。
    share_progress_with_friends: bool | None = None


@router.get("/profile")
async def read_profile(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await ensure_profile(session, user)
    await session.commit()
    return {"profile": profile_out(profile)}


@router.patch("/profile")
async def update_profile(
    payload: ProfilePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if payload.level is not None and payload.level not in VALID_LEVELS:
        raise HTTPException(status_code=400, detail="水平档位取值不合法")

    profile = await ensure_profile(session, user)

    if payload.level is not None:
        profile.level = payload.level
    if payload.notify_debate_reminder is not None:
        profile.notify_debate_reminder = payload.notify_debate_reminder
    if payload.auto_scan_event_cards is not None:
        profile.auto_scan_event_cards = payload.auto_scan_event_cards
    if payload.share_progress_with_friends is not None:
        # 关闭立即生效：这个字段是每次查好友列表时现读的，没有任何缓存
        profile.share_progress_with_friends = payload.share_progress_with_friends

    await session.commit()
    await session.refresh(profile)
    return {"profile": profile_out(profile)}


def profile_out(profile: UserProfile) -> dict:
    return {
        "level": profile.level,
        "notify_debate_reminder": profile.notify_debate_reminder,
        "auto_scan_event_cards": profile.auto_scan_event_cards,
        "share_progress_with_friends": profile.share_progress_with_friends,
        "updated_at": iso_utc(profile.updated_at),
    }


# ── 修改密码 ──────────────────────────────────────────────────


class PasswordChangePayload(BaseModel):
    current_password: str = Field(..., max_length=128)
    new_password: str = Field(..., max_length=128)


@router.patch("/password")
async def change_password(
    payload: PasswordChangePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """修改自己的密码。

    **必须验当前密码**：JWT 是一次性签发的，如果只看「已登录」就允许改密码，
    那么一台忘记登出的设备被人拿到，就能直接改密码把账号锁死。

    ⚠️ **已知限制（必须知道）**：改密码**不会让其他设备已签发的 JWT 失效**。
    这个项目用无状态 JWT + httpOnly cookie，没有 token 黑名单，
    所以旧的 token 在 7 天有效期内仍然可用。

    要做到「改密码 = 其他设备登出」，需要在 `user` 上加一列
    `password_changed_at`，并在 `get_current_user` 里比对 JWT 的 `iat`。
    那是独立的一次改动，这里先记下、不顺手做（避免把两件事混在一次发布里）。
    """
    from app.security import hash_password, validate_password_strength, verify_password

    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="当前密码不正确")

    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与当前密码相同")

    problem = validate_password_strength(payload.new_password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    user.password_hash = hash_password(payload.new_password)
    await session.commit()
    return {"ok": True}


def _row(obj, fields: tuple[str, ...]) -> dict:
    """把 ORM 对象转成可 JSON 化的 dict。

    注意要**区分 datetime 与 date**：
    `LoopLog.date`、`DailyState.date` 是纯日期（date），
    而 `date` 同样有 strftime，用 `hasattr(value, "strftime")` 判断会把它
    也送进 iso_utc()，然后在 `.tzinfo` 上崩掉。
    """
    out = {}
    for name in fields:
        value = getattr(obj, name, None)
        if isinstance(value, datetime):
            # 时间统一序列化成 ISO UTC，导出数据要能被别的程序直接读
            out[name] = iso_utc(value)
        elif isinstance(value, date):
            out[name] = value.isoformat()
        else:
            out[name] = value
    return out


@router.get("/export")
async def export_data(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """导出我的全部数据（JSON）。

    刻意**不包含** password_hash —— 导出是给用户带走自己的记录，
    不是给出一份可以直接拿去撞库的凭据。
    """
    profile = await session.scalar(select(UserProfile).where(UserProfile.user_id == user.id))

    weaknesses = list(
        (await session.execute(select(WeaknessCard).where(WeaknessCard.user_id == user.id)))
        .scalars()
        .all()
    )
    weakness_ids = [w.id for w in weaknesses]
    loops = (
        list(
            (
                await session.execute(
                    select(WeaknessLoop).where(WeaknessLoop.weakness_id.in_(weakness_ids))
                )
            )
            .scalars()
            .all()
        )
        if weakness_ids
        else []
    )
    logs = list(
        (await session.execute(select(LoopLog).where(LoopLog.user_id == user.id))).scalars().all()
    )
    advantages = list(
        (await session.execute(select(Advantage).where(Advantage.user_id == user.id)))
        .scalars()
        .all()
    )
    principles = list(
        (await session.execute(select(Principle).where(Principle.user_id == user.id)))
        .scalars()
        .all()
    )
    cards = list(
        (await session.execute(select(EventCard).where(EventCard.user_id == user.id)))
        .scalars()
        .all()
    )
    rooms = list(
        (await session.execute(select(DebateRoom).where(DebateRoom.user_id == user.id)))
        .scalars()
        .all()
    )
    room_ids = [r.id for r in rooms]
    messages = (
        list(
            (
                await session.execute(
                    select(DebateMessage).where(DebateMessage.room_id.in_(room_ids))
                )
            )
            .scalars()
            .all()
        )
        if room_ids
        else []
    )
    reviews = (
        list(
            (
                await session.execute(
                    select(DebateReview).where(DebateReview.room_id.in_(room_ids))
                )
            )
            .scalars()
            .all()
        )
        if room_ids
        else []
    )
    observations = list(
        (await session.execute(select(AIObservation).where(AIObservation.user_id == user.id)))
        .scalars()
        .all()
    )
    daily = list(
        (await session.execute(select(DailyState).where(DailyState.user_id == user.id)))
        .scalars()
        .all()
    )
    archives = list(
        (await session.execute(select(ArchiveRecord).where(ArchiveRecord.user_id == user.id)))
        .scalars()
        .all()
    )
    reminders = list(
        (await session.execute(select(DebateReminder).where(DebateReminder.user_id == user.id)))
        .scalars()
        .all()
    )

    payload = {
        "exported_at": iso_utc(now_utc()),
        "app": "对镜",
        "format_version": 1,
        "account": {
            **_row(user, ("id", "username", "nickname", "is_admin", "created_at")),
            "deletion_requested_at": iso_utc(user.deletion_requested_at),
        },
        "profile": (
            _row(profile, ("level", "notify_debate_reminder", "auto_scan_event_cards",
                           "share_progress_with_friends"))
            if profile
            else None
        ),
        "daily_states": [_row(d, ("date", "energy", "mood")) for d in daily],
        "weaknesses": [
            {
                **_row(
                    w,
                    (
                        "id", "name", "description", "status", "confidence",
                        "source", "created_at", "archived_at",
                    ),
                ),
                "domains": list(w.domains or []),
            }
            for w in weaknesses
        ],
        "loops": [
            _row(
                lp,
                (
                    "id", "weakness_id", "trigger_scene", "body_signal", "action_plan",
                    "status", "linked_advantage_ids", "linked_principle_ids",
                    "created_at", "updated_at",
                ),
            )
            for lp in loops
        ],
        "loop_logs": [
            _row(lg, ("id", "loop_id", "weakness_id", "date", "result", "note", "source", "created_at"))
            for lg in logs
        ],
        "advantages": [
            _row(a, ("id", "name", "source", "verified", "status", "created_at", "archived_at"))
            for a in advantages
        ],
        "principles": [
            _row(
                p,
                (
                    "id", "content", "source_type", "status", "confidence",
                    "pinned", "linked_loop_ids", "created_at", "updated_at",
                ),
            )
            for p in principles
        ],
        "event_cards": [
            _row(c, ("id", "content", "linked_loop_ids", "result", "analyzed", "created_at"))
            for c in cards
        ],
        "debates": [
            {
                **_row(
                    r,
                    (
                        "id", "topic", "stance", "status", "max_rounds",
                        "current_round", "created_at", "finished_at",
                    ),
                ),
                "messages": [
                    _row(m, ("id", "role", "content", "round", "seq", "created_at"))
                    for m in messages
                    if m.room_id == r.id
                ],
                "review": next(
                    (
                        _row(
                            rv,
                            (
                                "good", "notice", "next_time",
                                "alternative_action", "generated_at",
                            ),
                        )
                        for rv in reviews
                        if rv.room_id == r.id
                    ),
                    None,
                ),
            }
            for r in rooms
        ],
        "ai_observations": [
            _row(o, ("id", "type", "content", "source_type", "status", "created_at", "expires_at"))
            for o in observations
        ],
        "reminders": [
            _row(r, ("id", "room_id", "remind_at", "status", "created_at", "sent_at"))
            for r in reminders
        ],
        "archive_records": [
            _row(a, ("id", "object_type", "object_id", "reason", "archived_at", "restored_at"))
            for a in archives
        ],
        "stats": {
            "weakness_count": len(weaknesses),
            "loop_count": len(loops),
            "log_count": len(logs),
            "debate_count": len(rooms),
            "event_card_count": len(cards),
            "advantage_count": len(advantages),
            "principle_count": len(principles),
        },
    }

    logger.info("用户导出数据 user=%s", user.id)
    filename = f"duijing-export-{now_utc().strftime('%Y%m%d')}.json"
    return JSONResponse(
        content=payload,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/deletion")
async def deletion_status(user: User = Depends(get_current_user)):
    return {
        "requested": user.deletion_requested_at is not None,
        "requested_at": iso_utc(user.deletion_requested_at),
    }


@router.post("/deletion")
async def request_deletion(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """申请注销账号。

    刻意**不做即时物理删除**：弱点、破功记录这类数据对用户是有情感重量的，
    误删不可逆。这里只做标记，由开发者人工确认后再执行删除。

    同时会撤销推送订阅 —— 用户既然要走了，就不该再收到任何通知。
    """
    if user.deletion_requested_at is None:
        user.deletion_requested_at = now_utc()

    from app.models import PushSubscription

    subs = (
        (await session.execute(select(PushSubscription).where(PushSubscription.user_id == user.id)))
        .scalars()
        .all()
    )
    for sub in subs:
        await session.delete(sub)

    await session.commit()
    logger.warning("用户申请注销 user=%s username=%s", user.id, user.username)

    return {
        "ok": True,
        "requested_at": iso_utc(user.deletion_requested_at),
        "message": "已收到注销申请。数据会在人工确认后删除，期间你仍可正常使用。",
    }


@router.delete("/deletion")
async def cancel_deletion(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """撤销注销申请——给用户反悔的机会。"""
    user.deletion_requested_at = None
    await session.commit()
    return {"ok": True, "requested": False}
