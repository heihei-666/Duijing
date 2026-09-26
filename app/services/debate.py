"""对镜 · 辩论房编排

把 Prompt 组装（app/ai/prompts.py）、AI 路由（app/ai/router.py）
和数据落库串成一条完整链路。

三条不可违反的规则在此集中体现：
  · 观察只在辩论结束后产生，辩论中一律不打断（方案 3.1）
  · 每场最多 1 条优势观察 + 1 条弱点观察 + 1 条替代动作（第九章第 5 条）
  · 缓存前缀在同一场辩论内逐字节稳定（第九章第 3 条）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import prompts
from app.ai.router import (
    TASK_ALTERNATIVE,
    TASK_DEBATE_REPLY,
    TASK_REVIEW_CARD,
    TASK_TOPIC,
    complete,
    extract_json,
)
from app.config import settings
from app.models import (
    Advantage,
    DebateMessage,
    DebateReview,
    DebateRoom,
    DebateStatus,
    Principle,
    WeaknessCard,
    WeaknessLoop,
)
from app.services import observations as observation_service
from app.utils import clamp, now_utc

logger = logging.getLogger("duijing.debate")


class ReviewGenerationError(RuntimeError):
    """复盘卡片生成失败。

    刻意不做「兜底文案」——如果模型输出解析不了，
    与其给用户一张写着通用鼓励语的假复盘，不如明确告诉他失败了、可以重试。
    假的观察会污染弱点库，而弱点库是这个产品最不能脏的数据。
    """


# ─────────────────────────────────────────────────────────────
# 上下文与缓存前缀
# ─────────────────────────────────────────────────────────────


@dataclass(slots=True)
class DebateContext:
    """一场辩论里保持稳定的上下文，用于拼缓存前缀。"""

    weaknesses: list[WeaknessCard] = field(default_factory=list)
    advantages: list[Advantage] = field(default_factory=list)
    loop: WeaknessLoop | None = None
    weakness: WeaknessCard | None = None
    # "debater"（单人，AI 是对手）| "host"（多人，AI 是主持兼观察者）
    # 方案 3.1：多人辩论时「AI 做主持 + 观察，不作为独立辩手」
    mode: str = "debater"

    def stable_system(self) -> str:
        """辩论房用的缓存前缀（含人格）。

        人格由 mode 决定，但**在一个房间内不变**，所以缓存前缀依然逐字节稳定。
        """
        return prompts.build_stable_system(
            self.weaknesses, self.advantages, self.loop, self.weakness, mode=self.mode
        )

    def context_blocks(self) -> str:
        """只要用户档案，不要辩论人格。复盘等非辩论任务用这个。"""
        return prompts.build_context_blocks(
            self.weaknesses, self.advantages, self.loop, self.weakness
        )


async def load_context(
    session: AsyncSession, user_id: int, *, weakness_id: int | None = None,
    loop_id: int | None = None, mode: str = "debater",
) -> DebateContext:
    """加载拼接前缀所需的全部素材。

    弱点与优势都按 id 升序取出——prompts 层还会再排一次序，
    双重保险，因为前缀错一个字符缓存就全废。
    """
    weakness_rows = await session.execute(
        select(WeaknessCard)
        .where(WeaknessCard.user_id == user_id, WeaknessCard.status != "archived")
        .order_by(WeaknessCard.id.asc())
    )
    advantage_rows = await session.execute(
        select(Advantage)
        .where(Advantage.user_id == user_id)
        .order_by(Advantage.id.asc())
    )

    loop: WeaknessLoop | None = None
    weakness: WeaknessCard | None = None

    if loop_id:
        loop = await session.get(WeaknessLoop, loop_id)
        if loop is not None:
            weakness = await session.get(WeaknessCard, loop.weakness_id)
    elif weakness_id:
        weakness = await session.get(WeaknessCard, weakness_id)

    return DebateContext(
        weaknesses=list(weakness_rows.scalars().all()),
        advantages=list(advantage_rows.scalars().all()),
        loop=loop,
        weakness=weakness,
        mode=mode,
    )


# ─────────────────────────────────────────────────────────────
# 回合数
# ─────────────────────────────────────────────────────────────


def decide_max_rounds(topic: str, *, has_loop: bool = False, level: str = "novice") -> int:
    """在 4–8 之间定回合数。

    方案说「AI 根据辩题复杂度决定」。当前用确定性启发式估算，好处是：
      · Mock 与真实模型下行为一致，便于测试
      · 不会因为模型偶发输出非法轮次而破坏房间状态
    接入真实模型后可改为在辩题生成时一并询问，此处保持接口不变即可。
    """
    score = 5
    if len(topic) >= 18:
        score += 1
    if has_loop:
        score += 1
    if level == "advanced":
        score += 1
    elif level == "novice":
        score -= 1

    return clamp(score, settings.DEBATE_MIN_ROUNDS, settings.DEBATE_MAX_ROUNDS)


# ─────────────────────────────────────────────────────────────
# 消息
# ─────────────────────────────────────────────────────────────


async def next_seq(session: AsyncSession, room_id: int) -> int:
    """房间内单调递增序号，SSE 断线续传靠它。"""
    current = await session.scalar(
        select(func.max(DebateMessage.seq)).where(DebateMessage.room_id == room_id)
    )
    return int(current or 0) + 1


async def append_message(
    session: AsyncSession,
    room: DebateRoom,
    *,
    role: str,
    content: str,
    round_no: int = 0,
    user_id: int | None = None,
) -> DebateMessage:
    message = DebateMessage(
        room_id=room.id,
        role=role,
        user_id=user_id,
        content=content,
        round=round_no,
        seq=await next_seq(session, room.id),
    )
    session.add(message)
    await session.flush()
    return message


async def load_history(session: AsyncSession, room_id: int, *, limit: int = 40) -> list[DebateMessage]:
    rows = await session.execute(
        select(DebateMessage)
        .where(DebateMessage.room_id == room_id)
        .order_by(DebateMessage.seq.asc())
        .limit(limit)
    )
    return list(rows.scalars().all())


# ─────────────────────────────────────────────────────────────
# 生成
# ─────────────────────────────────────────────────────────────


async def generate_topic(scene: str, context: DebateContext) -> tuple[str, str]:
    """把用户输入的场景转成辩题。"""
    messages = prompts.build_topic_messages(scene, context.weaknesses)
    response = await complete(TASK_TOPIC, messages, temperature=0.8, max_tokens=300)
    payload = extract_json(response.text) or {}

    topic = (payload.get("topic") or "").strip() or scene.strip()[:60]
    stance = (payload.get("stance") or "").strip()
    return topic, stance


async def generate_opening(
    room: DebateRoom, context: DebateContext, *, level: str = "novice"
) -> str:
    messages = prompts.build_opening_messages(
        context.stable_system(), room.topic, room.stance, level=level, mode=context.mode
    )
    response = await complete(TASK_DEBATE_REPLY, messages, temperature=0.8, max_tokens=2000)
    return response.text.strip() or "我先开始：这个立场我持保留意见。你怎么看？"


def stream_reply(room: DebateRoom, context: DebateContext, history, latest: str, *, level: str = "novice"):
    """返回异步生成器，逐块吐字。调用方负责把最终文本落库。"""
    from app.ai.router import stream as ai_stream

    # history 是从库里按 seq 取的全量消息，**已经包含**用户刚发的那条；
    # build_debate_messages 还会把 latest 追加到末尾，不剔除就会把同一句话
    # 连续发两遍。模型收到重复发言会认为用户在强调，回答会跑偏。
    prior = [m for m in history if m.role in ("ai", "user", "system")]
    for index in range(len(prior) - 1, -1, -1):
        if prior[index].role == "user" and prior[index].content == latest:
            prior = prior[:index] + prior[index + 1 :]
            break

    messages = prompts.build_debate_messages(
        context.stable_system(),
        room.topic,
        room.stance,
        prior,
        latest,
        # host 模式下复用同一个参数位来切换发言指引；
        # 传字符串标记而不是加新参数，是为了不动已有的调用契约
        level="__host__" if context.mode == "host" else level,
    )
    # max_tokens 给足：思考模式下推理与正文共用预算，实测一次辩论回复
    # 推理约 400-500 token、正文约 250 token，800 在长回复时会不够。
    return ai_stream(TASK_DEBATE_REPLY, messages, temperature=0.85, max_tokens=2000)


async def generate_review(
    session: AsyncSession,
    room: DebateRoom,
    context: DebateContext,
    *,
    level: str = "novice",
) -> tuple[DebateReview, list]:
    """辩论结束 → 复盘卡片 + 观察入库。

    返回 (复盘卡片, 新建的观察列表)。
    观察数量被硬性限制为最多 1 优势 + 1 弱点。
    """
    history = await load_history(session, room.id, limit=80)
    transcript = "\n".join(
        f"{'AI' if m.role == 'ai' else '用户'}：{m.content}" for m in history
    )

    messages = prompts.build_review_messages(
        room.topic, room.stance, transcript, context.context_blocks(), level=level
    )
    # max_tokens 给足：即便已关闭思考模式，复盘要输出 6 个字段的 JSON，
    # 600 以下很容易被截断，截断的 JSON 解析出来是 None。
    response = await complete(TASK_REVIEW_CARD, messages, temperature=0.6, max_tokens=1500)

    if response.truncated:
        logger.warning("复盘输出被截断 room=%s finish_reason=length", room.id)

    payload = extract_json(response.text)
    if payload is None:
        logger.error(
            "复盘 JSON 解析失败 room=%s finish=%s 原文前200字=%r",
            room.id, response.finish_reason, (response.text or "")[:200],
        )
        raise ReviewGenerationError(
            "AI 返回的复盘内容无法解析，请稍后重试"
            if not response.truncated
            else "AI 复盘输出被截断，请重试"
        )

    def _text(key: str, fallback: str) -> str:
        value = payload.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else fallback

    review = await session.scalar(
        select(DebateReview).where(DebateReview.room_id == room.id)
    )
    if review is None:
        review = DebateReview(room_id=room.id, user_id=room.user_id)
        session.add(review)

    # 结构性字段缺失时留空串，由前端决定怎么展示；
    # 不填「你完整走完了这场辩论」这种放到谁身上都成立的废话——
    # 那会让用户以为 AI 真的观察了他。
    review.good = _text("good", "")
    review.notice = _text("notice", "")
    review.next_time = _text("next_time", "")
    review.alternative_action = _text("alternative_action", "")
    review.generated_at = now_utc()
    await session.flush()

    created = await _create_observations(session, room, payload)
    return review, created


async def _create_observations(session: AsyncSession, room: DebateRoom, payload: dict) -> list:
    """把复盘里的观察写进候选区。

    硬约束：最多 1 条优势 + 1 条弱点。多出来的直接丢弃，
    不因为模型多给了就多存。
    """
    created = []

    weakness = payload.get("weakness")
    if isinstance(weakness, dict):
        name = (weakness.get("name") or "").strip()
        if name:
            created.append(
                await observation_service.create_observation(
                    session,
                    user_id=room.user_id,
                    obs_type="weakness",
                    content=name,
                    source_type="debate",
                    source_id=room.id,
                )
            )

    advantage = payload.get("advantage")
    if isinstance(advantage, dict):
        name = (advantage.get("name") or "").strip()
        if name:
            created.append(
                await observation_service.create_observation(
                    session,
                    user_id=room.user_id,
                    obs_type="advantage",
                    content=name,
                    source_type="debate",
                    source_id=room.id,
                )
            )

    return created


async def generate_alternative_action(
    trigger_scene: str, action_plan: str, note: str
) -> str:
    """破功后给替代动作（方案 3.3）。"""
    messages = prompts.build_alternative_action_messages(trigger_scene, action_plan, note)
    response = await complete(TASK_ALTERNATIVE, messages, temperature=0.7, max_tokens=200)
    return response.text.strip()


async def create_principle_candidate(
    session: AsyncSession, *, user_id: int, room: DebateRoom, content: str
) -> Principle | None:
    """辩论房结论 → 原则候选（置信度：中）。

    方案 3.6 把「辩论房结论」列为原则来源之一。这里用复盘卡片的
    「如果再来一次」作为结论文本；内容为空或与已有原则重复时不建。
    """
    content = (content or "").strip()
    if not content:
        return None

    existing = await session.scalar(
        select(Principle).where(
            Principle.user_id == user_id,
            Principle.content == content,
        )
    )
    if existing is not None:
        return None

    principle = Principle(
        user_id=user_id,
        content=content[:200],
        source_type="debate_conclusion",
        source_id=room.id,
        status="candidate",
        confidence="medium",
    )
    session.add(principle)
    await session.flush()
    return principle


async def finish_room(session: AsyncSession, room: DebateRoom) -> None:
    room.status = DebateStatus.FINISHED.value
    room.finished_at = now_utc()
    await session.flush()
