"""对镜 · 结构化输出

【为什么要有这一层】

在此之前，所有「让模型返回 JSON」的任务都是同一套手写流程：

    payload = extract_json(response.text) or {}
    topic = (payload.get("topic") or "").strip()      # ← 模型给个数字就 AttributeError

靠自然语言请求 JSON、靠手工兜底解析，**没有任何 schema 约束**：

  · 没有 Pydantic 校验模型输出（Pydantic 只用在校验请求体上）
  · 没有 `response_format` / `json_schema`
  · 解析失败没有重试
  · 解析失败率没人统计（「JSON 解析成功率」是这个岗位的标准指标之一）

其中一条已经真实可触发：`generate_topic` 里 `(payload.get("topic") or "").strip()`，
模型若返回 `{"topic": 123}` 或 `{"topic": ["a"]}`，`.strip()` 直接 AttributeError → 500。

这一层做三件事：**校验、重试一次、统计失败率**。

【为什么 schema 写得这么宽松】

这里的目标是**挡住类型错误**，不是把模型的输出格式卡死。
所以字段基本都有默认值、`extra="ignore"`、并且对「本该是对象却是字符串」
这类常见偏差做归一化 —— 否则一个格式瑕疵会让整场辩论的复盘直接 502，
反而比现在更脆。
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

from app.ai.base import AIResponse, ChatMessage
from app.ai.router import complete, extract_json
from app.services import ai_metrics

logger = logging.getLogger("duijing.structured")


# ─────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────


class _Loose(BaseModel):
    """忽略多余字段 —— 模型多给几个键不该让整次调用失败。"""

    model_config = ConfigDict(extra="ignore")


class _Named(_Loose):
    name: str = ""


class TopicSuggestion(_Loose):
    """辩题生成（TASK_TOPIC）。"""

    topic: str = ""
    stance: str = ""


class ReviewPayload(_Loose):
    """复盘卡片（TASK_REVIEW_CARD）。

    三个文本块 + 替代动作 + 最多一条优势观察 + 一条弱点观察
    （方案第九章第 5 条：每场最多 1 优势 + 1 弱点 + 1 替代动作）。
    """

    good: str = ""
    notice: str = ""
    next_time: str = ""
    alternative_action: str = ""
    advantage: _Named | None = None
    weakness: _Named | None = None

    @field_validator("advantage", "weakness", mode="before")
    @classmethod
    def _coerce_named(cls, value: Any) -> Any:
        """模型有时直接给一个字符串而不是对象。

        旧代码用 `isinstance(value, dict)` 判断后静默丢弃 —— 那会**丢掉一条本该
        入库的观察**。这里改成归一化，能救回来就救回来。
        """
        if isinstance(value, str):
            return {"name": value} if value.strip() else None
        if isinstance(value, (int, float)):
            return None
        return value


class EventCardAnalysis(_Loose):
    """极简模式事件卡的判定（TASK_CANDIDATE / 扫描）。"""

    loop_id: int | None = None
    result: Literal["hold", "break", "not_triggered", "unsure"] = "unsure"
    reason: str = ""


class PrincipleCandidate(_Loose):
    """撑住率达标后提炼的原则（TASK_PRINCIPLE）。"""

    content: str = ""


class ScanCandidate(_Named):
    pass


class ScanCandidates(_Loose):
    """事件卡扫描产出的弱点候选（TASK_CANDIDATE）。"""

    candidates: list[ScanCandidate] = []

    @field_validator("candidates", mode="before")
    @classmethod
    def _drop_non_objects(cls, value: Any) -> Any:
        """模型偶尔在数组里混进字符串，丢掉那一项而不是让整次扫描失败。"""
        if not isinstance(value, list):
            return []
        cleaned = []
        for item in value:
            if isinstance(item, str):
                cleaned.append({"name": item})
            elif isinstance(item, dict):
                cleaned.append(item)
        return cleaned


# ─────────────────────────────────────────────────────────────
# 调用 + 校验 + 重试
# ─────────────────────────────────────────────────────────────


async def complete_json(
    task: str,
    messages: list[ChatMessage],
    schema: type[BaseModel],
    *,
    max_retries: int = 1,
    **kwargs,
) -> tuple[BaseModel | None, AIResponse | None]:
    """调模型 → 解析 JSON → 按 schema 校验；不合法就带上错误重试一次。

    返回 `(校验后的对象 或 None, 最后一次的 AIResponse 或 None)`。
    调用方根据第二个返回值决定错误措辞（截断 / 解析失败 / 不合 schema）。

    **为什么只重试一次**：失败通常是模型稳定地做不对（prompt 有问题），
    再试第三次只是把同一个错误重复一遍，还多花钱。
    真正该做的是把失败率统计出来，然后回去改 prompt ——
    这也正是 `ai_metrics` 记 `json_success_rate` 的原因。
    """
    conversation = list(messages)
    response: AIResponse | None = None
    last_error = "未执行"

    for attempt in range(max_retries + 1):
        response = await complete(task, conversation, **kwargs)

        last_error = _validate_into(response, schema)
        if last_error is None:
            ai_metrics.record_json_attempt(ok=True, task=task)
            ai_metrics.record_json_call(ok=True, task=task)
            return schema.model_validate(extract_json(response.text) or {}), response

        ai_metrics.record_json_attempt(ok=False, task=task)
        if attempt >= max_retries:
            break

        logger.warning(
            "结构化输出不合法，带错误重试一次 task=%s 原因=%s", task, last_error
        )
        conversation = conversation + [
            ChatMessage(role="assistant", content=(response.text or "")[:600]),
            ChatMessage(
                role="user",
                content=(
                    f"上面的输出不合法：{last_error}。"
                    "请只输出符合要求的 JSON，不要任何解释文字，不要代码围栏。"
                ),
            ),
        ]

    # 走到这里说明重试也用完了 —— 这一次「逻辑调用」失败了。
    # 与按尝试计的失败率分开记：用户关心的是「我的操作有没有成功」。
    ai_metrics.record_json_call(ok=False, task=task)
    return None, response


def _validate_into(response: AIResponse, schema: type[BaseModel]) -> str | None:
    """校验一次。合法返回 None，不合法返回一句人类可读的原因。"""
    if response.truncated:
        return "输出被 max_tokens 截断（finish_reason=length），JSON 不完整"
    raw = extract_json(response.text)
    if raw is None:
        return "返回内容里找不到合法的 JSON 对象"
    try:
        schema.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[:2]
        return f"JSON 不符合 schema：{first}"
    return None
