"""对镜 · 辩论房 API

包含 SSE 流式端点。方案 3.1 的多人权限规则在这里落实：
  · AI 观察只对发起人可见
  · 被邀请者看不到发起人的弱点标签、回环
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.config import settings
from app.db import get_session, session_scope
from app.deps import ensure_profile, get_current_user
from app.models import (
    AIObservation,
    EventCard,
    DebateMessage,
    DebateParticipant,
    DebateReview,
    DebateRoom,
    DebateStatus,
    User,
    WeaknessCard,
    WeaknessLoop,
)
from app.services import debate as debate_service
from app.services import metrics as metrics_service
from app.services import push as push_service
from app.services.ratelimit import ai_limiter, debate_limiter, enforce
from app.services.serializers import (
    debate_room_out,
    message_out,
    review_out,
)
from app.utils import generate_token, now_utc, to_utc

logger = logging.getLogger("duijing.api.debate")

router = APIRouter(prefix="/api/debates", tags=["辩论房"])


# ── 请求体 ────────────────────────────────────────────────────


class CreateDebatePayload(BaseModel):
    topic: str = Field("", max_length=200)
    stance: str = Field("", max_length=200)

    # 用户直接描述的场景，由 AI 转成辩题。
    # 对应方案 3.1 的 P0「用户自己出题」：用户往往说不出辩题，
    # 只会说「今天开会我又被怼了」——那才是输入端最自然的形态。
    scene: str = Field("", max_length=500)

    source_type: str = Field("manual", max_length=20)
    source_id: int | None = None
    loop_id: int | None = None
    weakness_id: int | None = None


class MessagePayload(BaseModel):
    content: str = Field(..., max_length=2000)


class ReminderPayload(BaseModel):
    """预约提醒。

    支持两种写法：给 preset（推荐，前端一个按钮就够）或给明确的 remind_at。
    预设存在的理由是降低门槛——让用户在手机上挑日期时间是给「预约」
    这件事本身增加摩擦，而预约正是我们要鼓励的行为。
    """

    preset: str = Field("", max_length=32)
    remind_at: str | None = Field(None, max_length=40)
    note: str = Field("", max_length=120)


# ── 权限 ──────────────────────────────────────────────────────


async def _participant_count(session: AsyncSession, room_id: int) -> int:
    return int(
        await session.scalar(
            select(func.count(DebateParticipant.id)).where(DebateParticipant.room_id == room_id)
        )
        or 0
    )


async def load_room_for_user(
    session: AsyncSession, room_id: int, user: User
) -> tuple[DebateRoom, bool, int]:
    """取房间并校验访问权。返回 (room, is_owner, participant_count)。"""
    room = await session.get(DebateRoom, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="辩论房不存在")

    is_owner = room.user_id == user.id
    if not is_owner:
        membership = await session.scalar(
            select(DebateParticipant).where(
                DebateParticipant.room_id == room_id,
                DebateParticipant.user_id == user.id,
            )
        )
        if membership is None:
            raise HTTPException(status_code=403, detail="你不在这个辩论房里")

    return room, is_owner, await _participant_count(session, room_id)


async def _nickname_map(session: AsyncSession, user_ids: list[int]) -> dict[int, str]:
    if not user_ids:
        return {}
    rows = await session.execute(select(User.id, User.nickname, User.username).where(User.id.in_(user_ids)))
    return {uid: (nick or uname) for uid, nick, uname in rows.all()}


# ── 列表 / 创建 ───────────────────────────────────────────────


@router.get("")
async def list_debates(
    status: str | None = None,
    status_filter: str | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """我参与过的辩论（含自己发起的和受邀加入的）。"""
    joined = select(DebateParticipant.room_id).where(DebateParticipant.user_id == user.id)

    stmt = select(DebateRoom).where(
        (DebateRoom.user_id == user.id) | (DebateRoom.id.in_(joined))
    )
    # 同时接受 status 与 status_filter：
    # API.md 第 3 章把参数写作 status，早期实现用的是 status_filter，
    # 两个名字都放行，避免任何一侧静默失效（筛选参数写错不会报错，
    # 只会返回全部数据——这类缺陷在页面上极难发现）。
    raw_status = status or status_filter
    if raw_status:
        wanted = [s.strip() for s in raw_status.split(",") if s.strip()]
        if wanted:
            stmt = stmt.where(DebateRoom.status.in_(wanted))

    stmt = stmt.order_by(DebateRoom.id.desc()).limit(100)
    rows = await session.execute(stmt)
    rooms = list(rows.scalars().all())

    items = []
    for room in rooms:
        is_owner = room.user_id == user.id
        weakness_name = None
        if is_owner and room.weakness_id:
            card = await session.get(WeaknessCard, room.weakness_id)
            weakness_name = card.name if card else None
        items.append(
            debate_room_out(
                room,
                is_owner=is_owner,
                participant_count=await _participant_count(session, room.id),
                weakness_name=weakness_name,
            )
        )
    return {"rooms": items, "total": len(items)}


@router.get("/suggestion")
async def debate_suggestion(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """方案 3.1 的辩题来源 P3：连续几天没主动出题时，根据弱点库生成一个辩题。

    注意这里**不是推送** —— 方案 3.9 规定「默认不推送，唯一例外是用户
    主动预约的辩论提醒」。所谓「推」只是在辩论页上放一个建议，
    用户打开才看得到。不要把它做成通知。

    结果按天缓存，避免每次打开辩论页都调一次模型。
    """
    profile = await ensure_profile(session, user)
    suggestion = await debate_service.build_suggestion(session, user, profile)
    await session.commit()
    return {"suggestion": suggestion}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_debate(
    payload: CreateDebatePayload,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    enforce(ai_limiter, f"debate-create:{user.id}", settings.AI_RATE_PER_MIN, "操作过于频繁")

    profile = await ensure_profile(session, user)

    # 辩题来源优先级（方案 3.1）：P0 用户自己出题 → P1 回环 → P2 事件卡 → P3 AI 生成
    loop_id, weakness_id = await _resolve_source(session, payload, user)
    # 刚创建时只有发起人，必然是单人模式
    context = await debate_service.load_context(
        session, user.id, weakness_id=weakness_id, loop_id=loop_id, mode="debater"
    )

    topic = payload.topic.strip()
    stance = payload.stance.strip()

    if not topic:
        scene = await _scene_from_source(session, payload, context, user)
        if not scene:
            raise HTTPException(
                status_code=400,
                detail="请提供辩题、场景描述（scene），或从弱点 / 回环 / 事件卡起辩",
            )
        topic, generated_stance = await debate_service.generate_topic(scene, context)
        stance = stance or generated_stance

    if not topic:
        raise HTTPException(status_code=400, detail="辩题生成失败，请手动输入辩题")

    # source_type 没显式给就按上下文推断，避免明明是从回环起的辩
    # 却记成 manual——那会让「我这段时间在练什么」这类统计失真。
    #
    # 只在 manual 时推断：显式传了 event_card / weakness 就尊重调用方，
    # 不要自作聪明去覆盖。
    #
    # （曾有一行 `elif payload.source_id and payload.source_type == "event_card"`
    #   试图在这里也识别事件卡来源，但那两个条件互斥、永远不会执行，
    #   是纯死代码。事件卡来源必须由调用方显式声明 source_type，
    #   靠 source_id 猜不出来——它可能指向任何一种对象。）
    source_type = payload.source_type
    if source_type == "manual" and (loop_id or weakness_id):
        source_type = "weakness"

    room = DebateRoom(
        user_id=user.id,
        topic=topic[:200],
        stance=stance[:200],
        status=DebateStatus.ACTIVE.value,
        source_type=source_type,
        source_id=payload.source_id,
        loop_id=loop_id,
        weakness_id=weakness_id,
        max_rounds=debate_service.decide_max_rounds(
            topic, has_loop=payload.loop_id is not None, level=profile.level
        ),
    )
    session.add(room)
    await session.flush()

    session.add(DebateParticipant(room_id=room.id, user_id=user.id, role="owner"))
    await session.flush()

    opening = await debate_service.generate_opening(room, context, level=profile.level)
    first = await debate_service.append_message(
        session, room, role="ai", content=opening, round_no=0
    )
    await session.commit()

    return {
        "room": debate_room_out(room, is_owner=True, participant_count=1),
        "first_message": message_out(first),
    }


async def _resolve_source(
    session: AsyncSession, payload: CreateDebatePayload, user: User
) -> tuple[int | None, int | None]:
    """把 source_type/source_id 归一成 (loop_id, weakness_id)。

    **这里的第一职责是归属校验，不是归一化。**

    `payload.weakness_id` 和 `payload.loop_id` 都是**直接来自请求体的裸整数**。
    此前只对 `source_type="weakness"` 那条分支校验了归属，另外两个字段不校验，
    于是：填上别人的 ID → 存进自己的房间 → 被 `load_context` 读进 AI 提示词
    → 再以 `weakness_name` 返回给调用方。这是一条**跨用户读取弱点**的路径，
    而方案第九章第 4 条写的是「弱点数据默认私密」。

    归属不符时**静默丢弃**而不是报错：报错会变成一个「这个 ID 是否存在」的探针。
    """
    loop_id: int | None = None
    weakness_id: int | None = None

    # ① 显式 weakness_id —— 必须是自己的
    if payload.weakness_id is not None:
        card = await session.get(WeaknessCard, payload.weakness_id)
        if card is not None and card.user_id == user.id:
            weakness_id = card.id

    # ② 显式 loop_id —— 先查回环，再顺着它的弱点确认归属
    if payload.loop_id is not None:
        loop = await session.get(WeaknessLoop, payload.loop_id)
        if loop is not None:
            owner_card = await session.get(WeaknessCard, loop.weakness_id)
            if owner_card is not None and owner_card.user_id == user.id:
                loop_id = loop.id
                # 给了 loop_id 就顺带把它的弱点也带上，AI 才能看到完整回环上下文
                if weakness_id is None:
                    weakness_id = owner_card.id

    # ③ 只有 source_type + source_id（弱点来源）
    if weakness_id is None and payload.source_type == "weakness" and payload.source_id:
        card = await session.get(WeaknessCard, payload.source_id)
        if card is not None and card.user_id == user.id:
            weakness_id = card.id

    # 事件卡来源没有「关联回环」的概念，只有一条内容当场景，
    # 它的归属校验在 _scene_from_source 里做。

    return loop_id, weakness_id


async def _scene_from_source(
    session: AsyncSession,
    payload: CreateDebatePayload,
    context: debate_service.DebateContext,
    user: User,
) -> str:
    """把「用户能说出口的东西」翻译成给 AI 的场景描述。

    优先级（对应方案 3.1 的辩题来源 P0–P3）：
      1. 用户直接描述的场景（P0，最自然——用户通常说不出辩题，只会说发生了什么）
      2. 关联的回环（P1）——用真实的触发场景与预案，而不是元语言
      3. 事件卡的场景（P2）
      4. 关联的弱点（P3 的前置：先有弱点才谈得上围绕它出题）

    注意这里产出的是**给模型的场景素材**，会被模型转写成辩题。
    不要写「围绕回环「X」的实战场景」这种元语言——模型会把它当字面内容
    塞进题目里，生成出「『围绕回环…的实战场景』这件事，问题出在做法还是判断」
    这种读起来很怪的题。
    """
    if payload.scene.strip():
        return payload.scene.strip()

    if context.loop is not None:
        parts = [f"我遇到过这样的情况：{context.loop.trigger_scene}。"]
        if context.loop.body_signal:
            parts.append(f"当时我的反应是{context.loop.body_signal}。")
        if context.loop.action_plan:
            parts.append(f"我打算这么做：{context.loop.action_plan}。")
        parts.append("这件事到底该怎么处理才对？")
        return "".join(parts)

    if payload.source_type == "event_card" and payload.source_id:
        card = await session.get(EventCard, payload.source_id)
        if card is not None and card.user_id == user.id:
            return f"我最近遇到了这样一件事：{card.content}"

    if context.weakness is not None:
        parts = [f"我发现自己有个问题：{context.weakness.name}。"]
        if context.weakness.description:
            parts.append(f"具体表现是{context.weakness.description}。")
        parts.append("这种事该怎么面对？")
        return "".join(parts)

    return ""


# ── 详情 ──────────────────────────────────────────────────────


@router.get("/{room_id}")
async def get_debate(
    room_id: int,
    after_seq: int = 0,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    room, is_owner, count = await load_room_for_user(session, room_id, user)

    rows = await session.execute(
        select(DebateMessage)
        .where(DebateMessage.room_id == room_id, DebateMessage.seq > after_seq)
        .order_by(DebateMessage.seq.asc())
    )
    messages = list(rows.scalars().all())

    nicknames = await _nickname_map(
        session, [m.user_id for m in messages if m.user_id is not None]
    )

    weakness_name = None
    if is_owner and room.weakness_id:
        card = await session.get(WeaknessCard, room.weakness_id)
        weakness_name = card.name if card else None

    payload = {
        "room": debate_room_out(
            room, is_owner=is_owner, participant_count=count, weakness_name=weakness_name
        ),
        "messages": [
            message_out(m, nickname=nicknames.get(m.user_id) if m.user_id else None)
            for m in messages
        ],
    }

    # AI 观察与复盘只对发起人可见（方案 3.1）
    if is_owner:
        review = await session.scalar(select(DebateReview).where(DebateReview.room_id == room_id))
        if review is not None:
            obs = await session.execute(
                select(AIObservation).where(
                    AIObservation.source_type == "debate",
                    AIObservation.source_id == room_id,
                )
            )
            payload["review"] = review_out(review, observations=list(obs.scalars().all()))
    return payload


# ── 发言 ──────────────────────────────────────────────────────


@router.post("/{room_id}/messages", status_code=status.HTTP_201_CREATED)
async def post_message(
    room_id: int,
    payload: MessagePayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    room, _is_owner, _count = await load_room_for_user(session, room_id, user)

    if room.status != DebateStatus.ACTIVE.value:
        raise HTTPException(status_code=409, detail="这场辩论已经结束或已暂停")

    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="发言不能为空")
    if len(content) > settings.DEBATE_MESSAGE_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"每轮发言不超过 {settings.DEBATE_MESSAGE_MAX_CHARS} 字",
        )

    enforce(
        debate_limiter,
        f"debate-msg:{user.id}",
        settings.DEBATE_RATE_PER_MIN,
        "发言过于频繁",
    )

    round_no = room.current_round + 1
    message = await debate_service.append_message(
        session, room, role="user", content=content, round_no=round_no, user_id=user.id
    )
    room.current_round = round_no
    await session.commit()

    return {
        "message": message_out(message, nickname=user.nickname or user.username),
        "round": round_no,
        "is_last_round": round_no >= room.max_rounds,
    }


@router.post("/{room_id}/abandon-round")
async def abandon_round(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """这轮我放弃。

    计入观察数据（作为「回避」信号，复盘时模型能看到），
    但不计入弱点触发次数——所以只写消息，不写 loop_log。
    """
    room, _is_owner, _count = await load_room_for_user(session, room_id, user)

    if room.status != DebateStatus.ACTIVE.value:
        raise HTTPException(status_code=409, detail="这场辩论已经结束或已暂停")

    round_no = room.current_round + 1
    message = await debate_service.append_message(
        session,
        room,
        role="user",
        content="（这轮我放弃）",
        round_no=round_no,
        user_id=user.id,
    )
    message.abandoned = True
    room.current_round = round_no
    await session.commit()

    return {
        "round": round_no,
        "message": message_out(message, nickname=user.nickname or user.username),
        "is_last_round": round_no >= room.max_rounds,
    }


# ── SSE ───────────────────────────────────────────────────────


@router.get("/{room_id}/stream")
async def stream_reply(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """SSE 流式获取 AI 回复。

    约定：客户端先 POST 发言，再打开这个端点。服务端取最后一条用户消息，
    生成 AI 回复并流式推送，结束时落库并发出 message / done 事件。

    注意：生成过程不能复用请求级 session（它会在响应结束后才关闭，
    而流式响应可能持续很久），所以内部另开一个 session_scope。
    """
    await load_room_for_user(session, room_id, user)  # 仅做权限校验

    async def event_generator():
        metrics_service.sse_opened()
        try:
            async with session_scope() as s:
                room = await s.get(DebateRoom, room_id)
                if room is None:
                    yield _sse("error", {"detail": "辩论房不存在"})
                    return

                history = await debate_service.load_history(s, room_id, limit=80)
                last_user = next((m for m in reversed(history) if m.role == "user"), None)
                if last_user is None:
                    yield _sse("done", {"round": room.current_round, "is_last_round": False})
                    return

                # 幂等保护：这一轮已经生成过 AI 回复就不再重复生成
                already = any(
                    m.role == "ai" and m.round == last_user.round and m.seq > last_user.seq
                    for m in history
                )
                if already:
                    existing = next(
                        m
                        for m in reversed(history)
                        if m.role == "ai" and m.round == last_user.round
                    )
                    yield _sse("message", {"message": message_out(existing)})
                    yield _sse(
                        "done",
                        {
                            "round": room.current_round,
                            "is_last_round": room.current_round >= room.max_rounds,
                        },
                    )
                    return

                owner = await s.get(User, room.user_id)
                profile = await ensure_profile(s, owner) if owner else None
                level = profile.level if profile else "novice"

                # 有人加入后 AI 要退到主持位（方案 3.1：多人时 AI 做主持 + 观察）。
                # 参与者数量变了，人格就变——但同一房间内是稳定的，
                # 所以缓存前缀不会因为刷新页面而失效。
                participants = int(
                    await s.scalar(
                        select(func.count(DebateParticipant.id)).where(
                            DebateParticipant.room_id == room_id
                        )
                    )
                    or 0
                )
                room_mode = "host" if participants > 1 else "debater"

                context = await debate_service.load_context(
                    s, room.user_id, weakness_id=room.weakness_id, loop_id=room.loop_id,
                    mode=room_mode,
                )

                buffer: list[str] = []
                async for piece in debate_service.stream_reply(
                    room, context, history, last_user.content, level=level
                ):
                    buffer.append(piece)
                    yield _sse("token", {"delta": piece})

                text = "".join(buffer).strip()
                if not text:
                    # 上游偶发「HTTP 200 但流是空的」（实测遇到过一次）。
                    # 这里**不能**填一句兜底台词存进去——那会让用户以为 AI 真的
                    # 这么回应了，而辩论文本是复盘和 AI 观察的唯一依据，
                    # 造假会一路污染到弱点库。宁可显式失败，让用户重试。
                    logger.error(
                        "AI 流式输出为空 room=%s round=%s provider=%s",
                        room_id, last_user.round, getattr(context, "_provider", "?"),
                    )
                    yield _sse("error", {"detail": "AI 这次没有返回内容，请重试"})
                    return

                ai_message = await debate_service.append_message(
                    s, room, role="ai", content=text, round_no=last_user.round
                )
                await s.commit()

                yield _sse("message", {"message": message_out(ai_message)})
                yield _sse(
                    "done",
                    {
                        "round": room.current_round,
                        "is_last_round": room.current_round >= room.max_rounds,
                    },
                )
        except Exception:  # noqa: BLE001 - 流里抛异常会让前端静默卡住，必须显式送出
            logger.exception("SSE 生成失败 room=%s", room_id)
            yield _sse("error", {"detail": "AI 生成失败，请重试"})
        finally:
            # 必须在 finally 里减：客户端中途关页面时生成器会被销毁，
            # 漏减一次计数就永远偏高，阈值告警从此失真。
            metrics_service.sse_closed()

    return EventSourceResponse(event_generator(), ping=15)


def _sse(event: str, payload: dict) -> dict:
    return {"event": event, "data": json.dumps(payload, ensure_ascii=False)}


# ── 结束 / 暂停 / 邀请 ────────────────────────────────────────


# ── 预约提醒（方案 3.9 里唯一的主动触达通道） ──────────────


@router.get("/{room_id}/reminder")
async def get_reminder(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    await load_room_for_user(session, room_id, user)
    reminder = await push_service.pending_reminder(session, user_id=user.id, room_id=room_id)
    return {"reminder": await push_service.reminder_out(reminder, room_id)}


@router.post("/{room_id}/reminder")
async def set_reminder(
    room_id: int,
    payload: ReminderPayload,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """预约一次辩论提醒。"""
    await load_room_for_user(session, room_id, user)

    if payload.preset:
        if payload.preset not in push_service.REMINDER_PRESETS:
            raise HTTPException(status_code=400, detail="未知的提醒时间")
        remind_at = push_service.resolve_preset(payload.preset)
    elif payload.remind_at:
        try:
            remind_at = datetime.fromisoformat(payload.remind_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="时间格式不正确")
        remind_at = to_utc(remind_at)
    else:
        raise HTTPException(status_code=400, detail="请选择提醒时间")

    if remind_at is None:
        raise HTTPException(status_code=400, detail="无法解析提醒时间")

    now = now_utc()
    if remind_at <= now:
        raise HTTPException(status_code=400, detail="提醒时间必须晚于现在")
    # 上限 30 天：再远就没有意义了，多半是误输入
    if remind_at > now + timedelta(days=30):
        raise HTTPException(status_code=400, detail="提醒时间最多只能预约 30 天内")

    devices = await push_service.device_count(session, user.id)
    reminder = await push_service.upsert_reminder(
        session, user_id=user.id, room_id=room_id, remind_at=remind_at, note=payload.note
    )
    await session.commit()
    await session.refresh(reminder)

    return {
        "reminder": await push_service.reminder_out(reminder, room_id),
        # 没有订阅设备时如实告知，而不是让用户以为约好了却收不到。
        # 前端据此提示「还需要开启通知」。
        "device_count": devices,
        "will_notify": devices > 0,
    }


@router.delete("/{room_id}/reminder")
async def delete_reminder(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    await load_room_for_user(session, room_id, user)
    cancelled = await push_service.cancel_reminder(session, user_id=user.id, room_id=room_id)
    await session.commit()
    return {"ok": True, "cancelled": cancelled}


@router.post("/{room_id}/finish")
async def finish_debate(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    room, is_owner, _count = await load_room_for_user(session, room_id, user)
    if not is_owner:
        raise HTTPException(status_code=403, detail="只有发起人可以结束辩论")

    enforce(ai_limiter, f"debate-finish:{user.id}", settings.AI_RATE_PER_MIN, "操作过于频繁")

    existing = await session.scalar(select(DebateReview).where(DebateReview.room_id == room_id))
    if existing is not None:
        return {"review": review_out(existing), "already_generated": True}

    profile = await ensure_profile(session, user)
    context = await debate_service.load_context(
        session, user.id, weakness_id=room.weakness_id, loop_id=room.loop_id
    )

    try:
        review, created = await debate_service.generate_review(
            session, room, context, level=profile.level
        )
    except debate_service.ReviewGenerationError as exc:
        # 502 而不是 500：这是上游 AI 返回了不可用的内容，
        # 不是本服务出错，也不该让用户以为「辩论数据丢了」——
        # 房间和消息都还在，重试一次即可。
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await debate_service.finish_room(session, room)

    # 辩论房结论 → 原则候选（置信度：中）
    principle = await debate_service.create_principle_candidate(
        session, user_id=user.id, room=room, content=review.next_time
    )

    await session.commit()
    await session.refresh(review)

    return {
        "review": review_out(review, observations=created),
        "principle_candidate": (
            {"id": principle.id, "content": principle.content} if principle else None
        ),
    }


@router.post("/{room_id}/review/dismiss-observations")
async def dismiss_observations(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """用户关闭本轮观察。

    方案 3.1：关闭后不产生弱点/优势数据。因此这里不仅要打标记，
    还要把本场已经产生的候选一并作废。
    """
    room, is_owner, _count = await load_room_for_user(session, room_id, user)
    if not is_owner:
        raise HTTPException(status_code=403, detail="只有发起人可以关闭观察")

    review = await session.scalar(select(DebateReview).where(DebateReview.room_id == room_id))
    if review is None:
        raise HTTPException(status_code=404, detail="这场辩论还没有复盘卡片")

    review.observations_dismissed = True

    rows = await session.execute(
        select(AIObservation).where(
            AIObservation.source_type == "debate",
            AIObservation.source_id == room_id,
            AIObservation.status == "pending",
        )
    )
    dismissed = 0
    for obs in rows.scalars().all():
        obs.status = "ignored"
        dismissed += 1

    await session.commit()
    return {"ok": True, "dismissed": dismissed}


@router.post("/{room_id}/pause")
async def pause_debate(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """暂停查资料，回来继续（方案 3.1）。数据完全保留。"""
    room, _is_owner, _count = await load_room_for_user(session, room_id, user)
    if room.status == DebateStatus.FINISHED.value:
        raise HTTPException(status_code=409, detail="这场辩论已经结束")
    room.status = DebateStatus.PAUSED.value
    await session.commit()
    return {"status": room.status}


@router.post("/{room_id}/resume")
async def resume_debate(
    room_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    room, _is_owner, _count = await load_room_for_user(session, room_id, user)
    if room.status == DebateStatus.FINISHED.value:
        raise HTTPException(status_code=409, detail="这场辩论已经结束")
    room.status = DebateStatus.ACTIVE.value
    await session.commit()
    return {"status": room.status}


@router.post("/{room_id}/invite")
async def invite_to_debate(
    room_id: int,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """生成邀请链接。最多 4 人（含发起人）。"""
    room, is_owner, count = await load_room_for_user(session, room_id, user)
    if not is_owner:
        raise HTTPException(status_code=403, detail="只有发起人可以邀请")

    if count >= settings.DEBATE_MAX_PARTICIPANTS:
        raise HTTPException(
            status_code=400,
            detail=f"辩论房最多 {settings.DEBATE_MAX_PARTICIPANTS} 人",
        )

    if not room.invite_token:
        room.invite_token = generate_token(24)
        await session.commit()

    base = str(request.base_url).rstrip("/")
    return {
        # 字段名用 invite_token 而不是 token：
        # 响应里已经有一个含义完全不同的认证 token 概念，
        # 再用 token 指代邀请令牌会和 /api/auth/login 的返回值混淆。
        "invite_token": room.invite_token,
        "link": f"{base}/debate/join/{room.invite_token}",
        "participant_count": count,
        "max_participants": settings.DEBATE_MAX_PARTICIPANTS,
    }


@router.post("/join/{invite_token}")
async def join_debate(
    invite_token: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """凭邀请链接加入。被邀请者需要有自己的账号（已与产品确认）。"""
    room = await session.scalar(select(DebateRoom).where(DebateRoom.invite_token == invite_token))
    if room is None:
        raise HTTPException(status_code=404, detail="邀请链接无效或已失效")

    existing = await session.scalar(
        select(DebateParticipant).where(
            DebateParticipant.room_id == room.id, DebateParticipant.user_id == user.id
        )
    )
    if existing is None:
        count = await _participant_count(session, room.id)
        if count >= settings.DEBATE_MAX_PARTICIPANTS:
            raise HTTPException(
                status_code=400,
                detail=f"辩论房已满（最多 {settings.DEBATE_MAX_PARTICIPANTS} 人）",
            )
        session.add(DebateParticipant(room_id=room.id, user_id=user.id, role="invitee"))
        await session.commit()

    # 被邀请者拿不到 loop_id / weakness_id / 观察
    return {
        "room": debate_room_out(
            room,
            is_owner=(room.user_id == user.id),
            participant_count=await _participant_count(session, room.id),
        )
    }
