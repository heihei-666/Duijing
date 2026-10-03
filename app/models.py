"""对镜 · 数据模型

表清单对应方案文档 4.4，另有三张「文档未列但实现必需」的表，
均已在字段注释里标注 [新增]，便于评审时核对：

    debate_participant  —— 多人辩论（最多 4 人）必须有参与者关系表
    debate_review       —— 复盘卡片需要持久化，否则刷新即失
    archive_record      —— 垃圾桶要显示「还有几天物理删除」，需要归档流水

字段命名原则：DB 列名尽量贴合文档 4.4 的 SQL 草稿，
Python 属性名用更易读的形式（如 domain_json 列 ↔ domains 属性）。
"""

from __future__ import annotations

import enum
from datetime import date as date_type
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.dbtypes import UTCDateTime


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────────────────────
# 枚举（用字符串常量，SQLite 里存 TEXT，便于人工排查）
# ─────────────────────────────────────────────────────────────


class WeaknessStatus(str, enum.Enum):
    AI_CANDIDATE = "ai_candidate"  # AI 观察候选区
    OBSERVING = "observing"  # 观察中
    IMPROVING = "improving"  # 改善中
    ARCHIVED = "archived"  # 暂存 / 已降级（垃圾桶）


class Domain(str, enum.Enum):
    WORK = "work"
    RELATIONSHIP = "relationship"
    EMOTION = "emotion"
    DECISION = "decision"
    EXPRESSION = "expression"
    HEALTH = "health"
    OTHER = "other"


class LoopStatus(str, enum.Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    NEEDS_REVISION = "needs_revision"  # 破功后进入待修订
    PAUSED = "paused"
    ARCHIVED = "archived"


class LoopResult(str, enum.Enum):
    HOLD = "hold"  # 撑住
    BREAK = "break"  # 破功
    NOT_TRIGGERED = "not_triggered"  # 未触发


class LogSource(str, enum.Enum):
    DEBATE = "debate"
    EVENT_CARD = "event_card"
    MANUAL = "manual"


class AdvantageStatus(str, enum.Enum):
    PENDING = "pending"  # 待确认
    CONFIRMED = "confirmed"  # 已确认
    ARCHIVED = "archived"  # 待确认超 30 天自动归档
    REMOVED = "removed"  # [新增] 用户移除，留痕用：AI 不再重复入库同一标签


class PrincipleStatus(str, enum.Enum):
    CANDIDATE = "candidate"
    ACTIVE = "active"
    ARCHIVED = "archived"
    IGNORED = "ignored"  # [新增] 忽略留痕：AI 不再重复推同一原则


class PrincipleConfidence(str, enum.Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class PrincipleSource(str, enum.Enum):
    LOOP_RATE = "loop_rate"  # 回环撑住率达标
    DEBATE_CONCLUSION = "debate_conclusion"  # 辩论房结论
    MANUAL = "manual"  # 用户手动新建
    AI_ALTERNATIVE = "ai_alternative"  # 破功后 AI 替代动作被采纳


class EventResult(str, enum.Enum):
    HOLD = "hold"
    BREAK = "break"
    NOT_TRIGGERED = "not_triggered"
    UNSURE = "unsure"  # AI 不确定，标记待确认


class ObservationType(str, enum.Enum):
    WEAKNESS = "weakness"
    ADVANTAGE = "advantage"


class ObservationStatus(str, enum.Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    IGNORED = "ignored"
    EXPIRED = "expired"


class DebateStatus(str, enum.Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    FINISHED = "finished"
    ABANDONED = "abandoned"


class DebateLevel(str, enum.Enum):
    """用户水平，决定 AI 风格：新手温和 / 中级正常 / 高级犀利。"""

    NOVICE = "novice"
    INTERMEDIATE = "intermediate"
    ADVANCED = "advanced"


class QueueStatus(str, enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    DONE = "done"
    FAILED = "failed"


# ─────────────────────────────────────────────────────────────
# 用户
# ─────────────────────────────────────────────────────────────


class User(Base):
    __tablename__ = "user"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    nickname: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # 邀请制注册
    invite_code: Mapped[str] = mapped_column(String(16), unique=True, index=True, nullable=False)
    invited_by: Mapped[int | None] = mapped_column(ForeignKey("user.id"), nullable=True)

    # 注销申请时间。按《个人信息保护法》，用户有权删除自己的数据；
    # 这里先做「申请标记 + 人工确认」，不做即时物理删除——
    # 弱点、破功记录这类数据对用户是有情感重量的，误删不可逆。
    deletion_requested_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    profile: Mapped["UserProfile"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.id} {self.username}>"


class UserProfile(Base):
    """用户偏好。

    方案 3.1 要求「AI 风格根据用户水平调节」，3.9 要求「通知默认关闭，
    唯一例外是用户主动预约的辩论提醒」——这两条都需要落库。
    """

    __tablename__ = "user_profile"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), unique=True, nullable=False
    )

    level: Mapped[str] = mapped_column(String(16), default=DebateLevel.NOVICE.value, nullable=False)

    # 通知默认关闭；只有用户主动预约辩论提醒时才为 true
    notify_debate_reminder: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # 事件卡自动扫描默认开启（每周日夜间）
    auto_scan_event_cards: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # 辩题来源 P3 的缓存：连续几天没主动出题时，AI 根据弱点库生成一个辩题推给用户。
    # 缓存一天，避免每次打开辩论页都调一次模型（那既慢又费钱）。
    suggested_topic: Mapped[str] = mapped_column(Text, default="", nullable=False)
    suggested_stance: Mapped[str] = mapped_column(Text, default="", nullable=False)
    suggested_topic_on: Mapped[date_type | None] = mapped_column(Date, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    user: Mapped[User] = relationship(back_populates="profile")


class DailyState(Base):
    """状态栏第一块：精力 / 心情。两项都可跳过，不填不显示。"""

    __tablename__ = "daily_state"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_daily_state_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )
    date: Mapped[date_type] = mapped_column(Date, index=True, nullable=False)

    energy: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 0–100
    mood: Mapped[str | None] = mapped_column(String(16), nullable=True)  # great|good|calm|low|bad

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


# ─────────────────────────────────────────────────────────────
# 弱点与回环
# ─────────────────────────────────────────────────────────────


class WeaknessCard(Base):
    __tablename__ = "weakness_card"
    __table_args__ = (Index("ix_weakness_user_status", "user_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # 影响领域，多选。DB 列名贴合文档的 domain_json
    domains: Mapped[list] = mapped_column("domain_json", JSON, default=list, nullable=False)

    status: Mapped[str] = mapped_column(
        String(20), default=WeaknessStatus.OBSERVING.value, nullable=False
    )
    confidence: Mapped[int] = mapped_column(Integer, default=3, nullable=False)  # 1–5 星
    source: Mapped[str] = mapped_column(String(16), default="user", nullable=False)  # ai|user
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # 近 30 天触发次数的物化缓存；写 loop_log 时更新，
    # 避免每次列表查询都做一次聚合。权威数据始终在 loop_log。
    trigger_count_30d: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # 拖入垃圾桶后 60 天的物理删除时间点
    delete_after: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    loops: Mapped[list["WeaknessLoop"]] = relationship(
        back_populates="weakness", cascade="all, delete-orphan"
    )


class WeaknessLoop(Base):
    """回环 —— 弱点的 SOP。"""

    __tablename__ = "weakness_loop"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    weakness_id: Mapped[int] = mapped_column(
        ForeignKey("weakness_card.id", ondelete="CASCADE"), index=True, nullable=False
    )

    trigger_scene: Mapped[str] = mapped_column(Text, nullable=False)  # 触发场景
    body_signal: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 身体/情绪信号
    action_plan: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 应对预案

    status: Mapped[str] = mapped_column(String(20), default=LoopStatus.DRAFT.value, nullable=False)

    # 预案可从优势库、原则库引用
    linked_advantage_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    linked_principle_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    weakness: Mapped[WeaknessCard] = relationship(back_populates="loops")
    logs: Mapped[list["LoopLog"]] = relationship(
        back_populates="loop", cascade="all, delete-orphan"
    )


class LoopLog(Base):
    """演练日志 —— 全系统唯一的事实来源。

    约束（方案第九章第 7 条）：所有经验变动必须写 loop_log，不直接改弱点状态。
    """

    __tablename__ = "loop_log"
    __table_args__ = (Index("ix_looplog_loop_date", "loop_id", "date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    loop_id: Mapped[int] = mapped_column(
        ForeignKey("weakness_loop.id", ondelete="CASCADE"), index=True, nullable=False
    )
    weakness_id: Mapped[int] = mapped_column(
        ForeignKey("weakness_card.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    date: Mapped[date_type] = mapped_column(Date, index=True, nullable=False)
    result: Mapped[str] = mapped_column(String(20), nullable=False)  # hold|break|not_triggered
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 一行复盘
    source: Mapped[str] = mapped_column(String(20), default=LogSource.MANUAL.value, nullable=False)
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    loop: Mapped[WeaknessLoop] = relationship(back_populates="logs")


# ─────────────────────────────────────────────────────────────
# 资源与沉淀
# ─────────────────────────────────────────────────────────────


class Advantage(Base):
    """优势库 —— 资源，不是成就墙。"""

    __tablename__ = "advantage"
    __table_args__ = (Index("ix_advantage_user_status", "user_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    source: Mapped[str] = mapped_column(String(16), default="ai", nullable=False)  # ai|user
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), default=AdvantageStatus.PENDING.value, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class Principle(Base):
    """原则库 —— 沉淀。候选不消失，不设 24 小时限制。"""

    __tablename__ = "principle"
    __table_args__ = (Index("ix_principle_user_status", "user_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_type: Mapped[str] = mapped_column(String(24), nullable=False)
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), default=PrincipleStatus.CANDIDATE.value, nullable=False
    )
    confidence: Mapped[str] = mapped_column(
        String(16), default=PrincipleConfidence.MEDIUM.value, nullable=False
    )
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # 一条原则可关联多个回环
    linked_loop_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


class EventCard(Base):
    """事件卡 —— 实战记录，永久保留。"""

    __tablename__ = "event_card"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    content: Mapped[str] = mapped_column(Text, nullable=False)  # 一句话
    linked_loop_ids: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    result: Mapped[str | None] = mapped_column(String(20), nullable=True)  # 含 unsure

    analyzed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 极简模式下 AI 不确定关联/结果时置 true，前端显示「待确认」
    pending_confirm: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)


# ─────────────────────────────────────────────────────────────
# 辩论房
# ─────────────────────────────────────────────────────────────


class DebateRoom(Base):
    __tablename__ = "debate_room"
    __table_args__ = (Index("ix_debate_user_status", "user_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )  # 发起人

    topic: Mapped[str] = mapped_column(Text, nullable=False)
    stance: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 用户立场

    status: Mapped[str] = mapped_column(
        String(20), default=DebateStatus.ACTIVE.value, nullable=False
    )
    max_rounds: Mapped[int] = mapped_column(Integer, default=6, nullable=False)  # 4–8
    current_round: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # 辩题来源：manual | weakness | event_card | ai
    source_type: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # 关联回环时，AI 故意制造触发场景但不告知用户
    loop_id: Mapped[int | None] = mapped_column(
        ForeignKey("weakness_loop.id", ondelete="SET NULL"), nullable=True
    )
    weakness_id: Mapped[int | None] = mapped_column(
        ForeignKey("weakness_card.id", ondelete="SET NULL"), nullable=True
    )

    # 多人辩论邀请
    invite_token: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    messages: Mapped[list["DebateMessage"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    participants: Mapped[list["DebateParticipant"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    review: Mapped["DebateReview | None"] = relationship(
        back_populates="room", uselist=False, cascade="all, delete-orphan"
    )


class DebateParticipant(Base):
    """[新增] 辩论参与者。

    方案 3.1 要求「最多 4 人（含发起人）」「AI 观察只对发起人可见」
    「被邀请者看不到发起人的弱点标签、回环、AI 观察」，
    这些权限判定都需要一张参与者关系表，文档的表清单里缺了它。
    """

    __tablename__ = "debate_participant"
    __table_args__ = (UniqueConstraint("room_id", "user_id", name="uq_participant_room_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_id: Mapped[int] = mapped_column(
        ForeignKey("debate_room.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), default="invitee", nullable=False)  # owner|invitee
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    room: Mapped[DebateRoom] = relationship(back_populates="participants")


class DebateMessage(Base):
    __tablename__ = "debate_message"
    __table_args__ = (Index("ix_message_room_seq", "room_id", "seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_id: Mapped[int] = mapped_column(
        ForeignKey("debate_room.id", ondelete="CASCADE"), index=True, nullable=False
    )

    role: Mapped[str] = mapped_column(String(16), nullable=False)  # ai|user|system
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )

    content: Mapped[str] = mapped_column(Text, nullable=False)
    round: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 房间内单调递增，SSE 断线重连靠它续传
    seq: Mapped[int] = mapped_column(Integer, nullable=False)

    # 「这轮我放弃」（方案 3.1）。计入观察数据（作为「回避」信号），
    # 但不计入弱点的触发次数——所以必须与普通发言区分开，不能靠内容匹配。
    abandoned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    room: Mapped[DebateRoom] = relationship(back_populates="messages")


class DebateReview(Base):
    """[新增] 复盘卡片。

    方案 3.1 定义了三块内容（做得好 / 值得注意 / 如果再来一次）
    加 1 条替代动作，这些必须在辩论结束后持久化，否则刷新页面即丢失。
    """

    __tablename__ = "debate_review"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_id: Mapped[int] = mapped_column(
        ForeignKey("debate_room.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    good: Mapped[str] = mapped_column(Text, default="", nullable=False)
    notice: Mapped[str] = mapped_column(Text, default="", nullable=False)
    next_time: Mapped[str] = mapped_column(Text, default="", nullable=False)
    alternative_action: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # 用户可关闭本轮观察；关闭后不产生弱点/优势数据
    observations_dismissed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    generated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    room: Mapped[DebateRoom] = relationship(back_populates="review")


# ─────────────────────────────────────────────────────────────
# AI 观察与队列
# ─────────────────────────────────────────────────────────────


class AIObservation(Base):
    """AI 观察候选。

    方案 3.8：候选存活 24 小时，**从首次看到算**，不是从生成算。
    因此 first_seen_at 是必需的列（文档字段表里没写，但规则要求它）。
    """

    __tablename__ = "ai_observation"
    __table_args__ = (Index("ix_observation_user_status", "user_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    type: Mapped[str] = mapped_column(String(16), nullable=False)  # weakness|advantage
    content: Mapped[str] = mapped_column(Text, nullable=False)

    source_type: Mapped[str] = mapped_column(String(20), nullable=False)  # debate|event_card|scan
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), default=ObservationStatus.PENDING.value, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    # 首次被 GET /api/observations 返回的时间；24 小时倒计时从这里起算
    first_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class AIQueue(Base):
    """AI 延迟任务队列。

    方案 5.4：事件卡不实时扫描，进队列，每周日 02:00 批量处理。
    """

    __tablename__ = "ai_queue"
    __table_args__ = (Index("ix_queue_status_created", "status", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    task_type: Mapped[str] = mapped_column(String(32), nullable=False)  # scan_event_cards|...
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), default=QueueStatus.PENDING.value, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class ArchiveRecord(Base):
    """[新增] 归档流水。

    垃圾桶要展示「还有几天物理删除」，并且恢复时要保留触发计数，
    这些都需要一条可追溯的归档记录。
    """

    __tablename__ = "archive_record"
    __table_args__ = (Index("ix_archive_user_type", "user_id", "object_type"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    object_type: Mapped[str] = mapped_column(String(20), nullable=False)  # weakness|advantage|principle
    object_id: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(String(32), default="manual", nullable=False)

    archived_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    delete_after: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    restored_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)



# ─────────────────────────────────────────────────────────────
# 推送订阅与辩论提醒
#
# 这是产品里**唯一的主动留存钩子**。
# 方案 3.9 明确「默认不推送，唯一例外是用户主动预约的辩论提醒」——
# 也就是说推送权是用户借给我们的，只能用在他自己约的那个时间点上。
# 任何时候都不该用它来催事件卡、催演练、推活动。
# ─────────────────────────────────────────────────────────────


class PushSubscription(Base):
    """浏览器的 Web Push 订阅信息。

    一个用户可以有多条（手机 + 电脑）。endpoint 由浏览器推送服务分配，
    全局唯一；同一 endpoint 重复订阅时更新密钥而不是新增。
    """

    __tablename__ = "push_subscription"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )

    # 推送服务地址，长度可能很长（Chrome 的 endpoint 常在 200 字符以上）
    endpoint: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)

    # 仅用于在设置页展示「哪台设备」，不参与逻辑
    user_agent: Mapped[str] = mapped_column(String(255), default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # 推送服务返回 404/410 说明订阅已失效，标记后不再重试
    failed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class DebateReminder(Base):
    """用户主动预约的辩论提醒。"""

    __tablename__ = "debate_reminder"
    __table_args__ = (Index("ix_reminder_status_time", "status", "remind_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), index=True, nullable=False
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("debate_room.id", ondelete="CASCADE"), index=True, nullable=False
    )

    # 到点时间（UTC 存储，用户看到的是本地时间）
    remind_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True, nullable=False)
    # pending | sent | cancelled | failed
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    note: Mapped[str] = mapped_column(String(120), default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class AICallLog(Base):
    """每一次模型调用的观测记录。

    【为什么要有这张表】

    在此之前，`AIUsage`（含 prompt/completion/cached tokens）在 provider 层
    认真采集了，却**没有任何读取方**——没有落库、没有聚合、没有日志。
    连带地 `AIResponse.reasoning` 没人读、`PROMPT_VERSION` 也从不下发。
    结果就是：方案第五章的「月度成本 0.74 元」和验收记录里的
    「0.02–0.03 元/场」全都是**人工在服务商后台看的**，系统里没有这个能力。

    更要紧的是：这个项目主打的三个技术点（多模型路由、prompt 前缀缓存、
    SSE 流式）**都无法自证**——
      路由：两家的延迟/失败率/成本各是多少？路由错了怎么发现？
      缓存：命中率多少？省了多少钱？
      流式：TTFT 多少？
    这些问题的答案全都在 `AIUsage` 里，只是被丢掉了。

    这张表把它们留下来。写入走「内存缓冲 + 定时落库」（见
    `app/services/ai_metrics.py`），**不在请求事务里写**：
    SQLite 的写锁是全局的，而 AI 调用经常发生在请求事务已 flush、
    尚未 commit 的中间态，直接写会撞 busy_timeout。
    """

    __tablename__ = "ai_call_log"
    __table_args__ = (
        Index("ix_aicall_created", "created_at"),
        Index("ix_aicall_task_created", "task", "created_at"),
        Index("ix_aicall_user_created", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 允许为空：定时任务与后台任务发起的调用没有「当前用户」
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )

    # 方案 5.3 路由决策表里的任务名（debate_reply / review_card / ...）
    task: Mapped[str] = mapped_column(String(32), nullable=False)
    # 实际用到的 provider 名：deepseek / mimo / mock
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    model: Mapped[str] = mapped_column(String(64), default="", nullable=False)

    # 缓存前缀的版本号。落库之后才能回答「这条观察是哪个 prompt 版本产生的」，
    # 也才能按版本做效果对比 —— 在此之前它只是个没人用的常量。
    prompt_version: Mapped[str] = mapped_column(String(32), default="", nullable=False)

    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # provider 报的缓存命中 token（DeepSeek/MiMo 都是 prompt_cache_hit_tokens）
    cached_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 首 token 延迟，只有流式调用有值
    ttft_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # ok | error | aborted（aborted = 客户端中途断开，SSE 常见）
    status: Mapped[str] = mapped_column(String(16), default="ok", nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 流式调用标记，便于把「一个字的延迟」和「一整段的总时长」分开看
    streamed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)


__all__ = [
    "utcnow",
    "AICallLog",
    "WeaknessStatus",
    "Domain",
    "LoopStatus",
    "LoopResult",
    "LogSource",
    "AdvantageStatus",
    "PrincipleStatus",
    "PrincipleConfidence",
    "PrincipleSource",
    "EventResult",
    "ObservationType",
    "ObservationStatus",
    "DebateStatus",
    "DebateLevel",
    "QueueStatus",
    "User",
    "UserProfile",
    "DailyState",
    "WeaknessCard",
    "WeaknessLoop",
    "LoopLog",
    "Advantage",
    "Principle",
    "EventCard",
    "DebateRoom",
    "DebateParticipant",
    "DebateMessage",
    "DebateReview",
    "AIObservation",
    "AIQueue",
    "ArchiveRecord",
    "PushSubscription",
    "DebateReminder",
]
