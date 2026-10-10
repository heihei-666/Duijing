"""对镜 · 序列化层

所有 ORM 对象 → 契约 JSON 的转换都集中在这里。
好处：字段一旦要改，只改一处；也方便对照 docs/API.md 逐条核对。
"""

from __future__ import annotations

from datetime import datetime

from app.models import (
    Advantage,
    AIObservation,
    DebateMessage,
    DebateReview,
    DebateRoom,
    EventCard,
    LoopLog,
    Principle,
    User,
    WeaknessCard,
    WeaknessLoop,
)
from app.utils import days_since, iso_utc

# ─────────────────────────────────────────────────────────────
# 用户
# ─────────────────────────────────────────────────────────────


def user_out(user: User) -> dict:
    """当前用户的序列化（只被 `api/auth.py` 用于登录/注册/me）。

    `is_admin` 是**用户自己的标志**，不是别人的 —— 前端需要它来决定
    要不要显示管理区块。这里不是把管理权限列表暴露出去，只是让本人
    知道自己是不是管理员，否则界面只能靠「请求 403 再隐藏」来猜。
    """
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname or user.username,
        "is_admin": user.is_admin,
        "created_at": iso_utc(user.created_at),
    }


# ─────────────────────────────────────────────────────────────
# 弱点 / 回环 / 演练日志
# ─────────────────────────────────────────────────────────────


def weakness_out(
    card: WeaknessCard,
    *,
    trigger_count: int = 0,
    hold_count: int = 0,
    hold_rate: int | None = None,
    plan_count: int = 0,
    drill_count: int = 0,
    trend: "object | None" = None,
) -> dict:
    """弱点卡。

    角标格式见方案 3.2：普通卡「演练 3 · 预案 1 · 12天前建」，
    对应 drill_count / plan_count / days_since_created。
    """
    return {
        "id": card.id,
        "name": card.name,
        "description": card.description or "",
        "domains": list(card.domains or []),
        "status": card.status,
        "confidence": card.confidence,
        "source": card.source,
        "source_id": card.source_id,
        "trigger_count_30d": trigger_count,
        "hold_count_30d": hold_count,
        # None 表示「还没有触发数据」，前端显示「--」而不是 0%。
        # 0 的含义是「每次都破功」，两者绝不能混为一谈。
        "hold_rate_30d": hold_rate,
        **_trend_fields(trend),
        "plan_count": plan_count,
        "drill_count": drill_count,
        "days_since_created": days_since(card.created_at),
        "created_at": iso_utc(card.created_at),
        "archived_at": iso_utc(card.archived_at),
        "delete_after": iso_utc(card.delete_after),
        "days_until_delete": _days_until(card.delete_after),
    }


def loop_out(
    loop: WeaknessLoop,
    *,
    weakness: WeaknessCard | None = None,
    trigger_count: int = 0,
    hold_count: int = 0,
    hold_rate: int | None = None,
    advantages: list[Advantage] | None = None,
    principles: list[Principle] | None = None,
    trend: "object | None" = None,
) -> dict:
    return {
        "id": loop.id,
        "weakness_id": loop.weakness_id,
        "weakness_name": weakness.name if weakness else "",
        "trigger_scene": loop.trigger_scene,
        "body_signal": loop.body_signal or "",
        "action_plan": loop.action_plan or "",
        "status": loop.status,
        "linked_advantages": [
            {"id": a.id, "name": a.name} for a in (advantages or [])
        ],
        "linked_principles": [
            {"id": p.id, "content": p.content} for p in (principles or [])
        ],
        "trigger_count_30d": trigger_count,
        "hold_count_30d": hold_count,
        "hold_rate_30d": hold_rate,
        **_trend_fields(trend),
        "created_at": iso_utc(loop.created_at),
        "updated_at": iso_utc(loop.updated_at),
    }


def log_out(log: LoopLog) -> dict:
    return {
        "id": log.id,
        "loop_id": log.loop_id,
        "weakness_id": log.weakness_id,
        "date": log.date.isoformat() if log.date else None,
        "result": log.result,
        "note": log.note or "",
        "source": log.source,
        "source_id": log.source_id,
        "created_at": iso_utc(log.created_at),
    }


# ─────────────────────────────────────────────────────────────
# 资源与沉淀
# ─────────────────────────────────────────────────────────────


def advantage_out(adv: Advantage) -> dict:
    return {
        "id": adv.id,
        "name": adv.name,
        "source": adv.source,
        "source_id": adv.source_id,
        "verified": adv.verified,
        "status": adv.status,
        "created_at": iso_utc(adv.created_at),
        "archived_at": iso_utc(adv.archived_at),
    }


def principle_out(principle: Principle, *, linked_loops: list[WeaknessLoop] | None = None) -> dict:
    return {
        "id": principle.id,
        "content": principle.content,
        "source_type": principle.source_type,
        "source_id": principle.source_id,
        "status": principle.status,
        "confidence": principle.confidence,
        "pinned": principle.pinned,
        "linked_loop_ids": list(principle.linked_loop_ids or []),
        "linked_loops": [
            {"id": lp.id, "trigger_scene": lp.trigger_scene} for lp in (linked_loops or [])
        ],
        "created_at": iso_utc(principle.created_at),
        "updated_at": iso_utc(principle.updated_at),
    }


def event_card_out(
    card: EventCard, *, loops: list[WeaknessLoop] | None = None
) -> dict:
    return {
        "id": card.id,
        "content": card.content,
        "linked_loop_ids": list(card.linked_loop_ids or []),
        "linked_loops": [
            {"id": lp.id, "trigger_scene": lp.trigger_scene} for lp in (loops or [])
        ],
        "result": card.result,
        "analyzed": card.analyzed,
        "pending_confirm": card.pending_confirm,
        "created_at": iso_utc(card.created_at),
    }


def observation_out(obs: AIObservation, *, expires_at: datetime | None = None) -> dict:
    return {
        "id": obs.id,
        "type": obs.type,
        "content": obs.content,
        "source_type": obs.source_type,
        "source_id": obs.source_id,
        "status": obs.status,
        "first_seen_at": iso_utc(obs.first_seen_at),
        "created_at": iso_utc(obs.created_at),
        "expires_at": iso_utc(expires_at if expires_at is not None else obs.expires_at),
    }


# ─────────────────────────────────────────────────────────────
# 辩论房
# ─────────────────────────────────────────────────────────────


def message_out(msg: DebateMessage, *, nickname: str | None = None) -> dict:
    return {
        "id": msg.id,
        "room_id": msg.room_id,
        "role": msg.role,
        "user_id": msg.user_id,
        "nickname": nickname,
        "content": msg.content,
        "round": msg.round,
        "seq": msg.seq,
        "created_at": iso_utc(msg.created_at),
    }


def debate_room_out(
    room: DebateRoom,
    *,
    is_owner: bool,
    participant_count: int = 1,
    weakness_name: str | None = None,
) -> dict:
    """辩论房间。

    注意：`loop_id` / `weakness_id` 只对发起人返回真值（方案 3.1：
    被邀请者看不到发起人的弱点标签、回环、AI 观察）。
    """
    return {
        "id": room.id,
        "topic": room.topic,
        "stance": room.stance or "",
        "status": room.status,
        "max_rounds": room.max_rounds,
        "current_round": room.current_round,
        "source_type": room.source_type,
        "source_id": room.source_id,
        "is_owner": is_owner,
        "participant_count": participant_count,
        "loop_id": room.loop_id if is_owner else None,
        "weakness_id": room.weakness_id if is_owner else None,
        "weakness_name": (weakness_name if is_owner else None),
        "created_at": iso_utc(room.created_at),
        "finished_at": iso_utc(room.finished_at),
    }


def review_out(
    review: DebateReview, *, observations: list[AIObservation] | None = None
) -> dict:
    """复盘卡片。三块三色，对应配色方案第五章。"""
    return {
        "room_id": review.room_id,
        "good": {"title": "做得好", "content": review.good},
        "notice": {"title": "值得注意", "content": review.notice},
        "next_time": {"title": "如果再来一次", "content": review.next_time},
        "observations": [
            {"id": o.id, "type": o.type, "content": o.content} for o in (observations or [])
        ],
        "alternative_action": review.alternative_action,
        "observations_dismissed": review.observations_dismissed,
        "generated_at": iso_utc(review.generated_at),
    }


# ─────────────────────────────────────────────────────────────
# 内部
# ─────────────────────────────────────────────────────────────


def _trend_fields(trend) -> dict:
    """本周 vs 上周的对比字段。

    任一周没有触发数据时 delta 为 None —— 前端据此**不显示**趋势，
    而不是显示一个「↑ 0%」制造「我在原地踏步」的错觉。
    """
    if trend is None:
        return {"hold_rate_7d": None, "hold_rate_prev_7d": None, "trend_delta": None}
    return {
        "hold_rate_7d": trend.rate_7d,
        "hold_rate_prev_7d": trend.rate_prev_7d,
        "trend_delta": trend.delta,
    }


def _days_until(value: datetime | None) -> int | None:
    """距物理删除还有几天（垃圾桶用）。"""
    if value is None:
        return None
    from app.utils import now_utc, to_utc

    delta = to_utc(value) - now_utc()
    return max(0, delta.days)
