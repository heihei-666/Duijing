"""对镜 · AI 路由层

方案 5.3 的路由决策表，**不得更改**（第九章第 2 条硬性约束）：

    任务            模型
    辩论房对话       DeepSeek   ← 需要深度推理
    复盘卡片         MiMo
    辩题生成         MiMo
    事件卡扫描       MiMo
    回环对话         MiMo
    弱点/优势候选    MiMo

核心原则：需要深度推理的走 DeepSeek，结构化/短输出的走 MiMo。
"""

from __future__ import annotations

import json
import logging
import re

from app.ai.base import AIError, AIProvider, AIResponse, BaseProvider, ChatMessage
from app.ai.mock import MockProvider
from app.ai.providers import DeepSeekProvider, MiMoProvider
from app.config import settings

logger = logging.getLogger("duijing.ai")


# ── 任务标识 ──────────────────────────────────────────────────
TASK_DEBATE_REPLY = "debate_reply"
TASK_REVIEW_CARD = "review_card"
TASK_TOPIC = "topic_generation"
TASK_EVENT_SCAN = "event_scan"
TASK_LOOP_DIALOG = "loop_dialog"
TASK_CANDIDATE = "candidate"
TASK_ALTERNATIVE = "alternative_action"
TASK_PRINCIPLE = "principle_extract"

# 走 DeepSeek 的任务（深度推理）
REASONING_TASKS = frozenset({TASK_DEBATE_REPLY})
# 其余一律走 MiMo

_deepseek: DeepSeekProvider | None = None
_mimo: MiMoProvider | None = None
_mock: MockProvider | None = None


def _get_deepseek() -> DeepSeekProvider:
    global _deepseek
    if _deepseek is None:
        _deepseek = DeepSeekProvider()
    return _deepseek


def _get_mimo() -> MiMoProvider:
    global _mimo
    if _mimo is None:
        _mimo = MiMoProvider()
    return _mimo


def _get_mock() -> MockProvider:
    global _mock
    if _mock is None:
        _mock = MockProvider()
    return _mock


def reset_providers() -> None:
    """测试用：切换环境变量后重建实例。"""
    global _deepseek, _mimo, _mock
    _deepseek = _mimo = _mock = None


def get_provider(task: str) -> AIProvider:
    """按任务挑选 Provider。

    真实的 Key 缺失时**自动降级到 Mock**，并打一条警告——
    宁可让用户看到模拟内容，也不要让辩论房直接 500。
    """
    mode = settings.AI_PROVIDER

    if mode == "mock":
        return _get_mock()

    if mode == "deepseek":
        provider = _get_deepseek()
        return provider if provider.configured else _fallback("DEEPSEEK_API_KEY 未配置")

    if mode == "mimo":
        provider = _get_mimo()
        return provider if provider.configured else _fallback("MIMO_API_KEY 未配置")

    if mode == "hybrid":
        if task in REASONING_TASKS:
            provider = _get_deepseek()
            return provider if provider.configured else _fallback("DEEPSEEK_API_KEY 未配置")
        provider = _get_mimo()
        return provider if provider.configured else _fallback("MIMO_API_KEY 未配置")

    logger.warning("未知的 AI_PROVIDER=%s，回退到 mock", mode)
    return _get_mock()


def _fallback(reason: str) -> AIProvider:
    logger.warning("AI 降级为 Mock：%s", reason)
    return _get_mock()


async def complete(task: str, messages: list[ChatMessage], **kwargs) -> AIResponse:
    provider = get_provider(task)
    try:
        return await provider.complete(messages, **kwargs)
    except AIError:
        if provider.name != "mock":
            logger.exception("AI 调用失败，本次降级为 Mock")
            return await _get_mock().complete(messages, **kwargs)
        raise


def stream(task: str, messages: list[ChatMessage], **kwargs):
    """返回异步生成器。真实模型失败时降级为 Mock 流。"""
    provider = get_provider(task)

    async def _gen():
        try:
            async for piece in provider.stream(messages, **kwargs):
                yield piece
        except AIError:
            if provider.name == "mock":
                raise
            logger.exception("AI 流式调用失败，降级为 Mock")
            async for piece in _get_mock().stream(messages, **kwargs):
                yield piece

    return _gen()


# ─────────────────────────────────────────────────────────────
# 结构化输出解析
# ─────────────────────────────────────────────────────────────

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def extract_json(text: str) -> dict | None:
    """从模型输出里抠出 JSON。

    真实模型经常在 JSON 外面裹一层 ```json 围栏，或者加一句「好的，这是结果：」，
    这里做三层兜底：直接解析 → 去围栏 → 取第一个平衡花括号块。
    """
    if not text:
        return None

    candidate = text.strip()

    for attempt in (candidate, _strip_fence(candidate), _first_json_object(candidate)):
        if not attempt:
            continue
        try:
            parsed = json.loads(attempt)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue
    return None


def _strip_fence(text: str) -> str | None:
    match = _FENCE_RE.search(text)
    return match.group(1).strip() if match else None


def _first_json_object(text: str) -> str | None:
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        ch = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def provider_status() -> dict:
    """给 /api/health 用的诊断信息，不泄露 Key 本身。"""
    return {
        "mode": settings.AI_PROVIDER,
        "deepseek_configured": bool(settings.DEEPSEEK_API_KEY),
        "deepseek_model": settings.DEEPSEEK_MODEL,
        "mimo_configured": bool(settings.MIMO_API_KEY),
        "mimo_model": settings.MIMO_MODEL,
        "degraded": settings.AI_PROVIDER != "mock"
        and not (settings.DEEPSEEK_API_KEY or settings.MIMO_API_KEY),
    }


__all__ = [
    "AIError",
    "AIProvider",
    "AIResponse",
    "BaseProvider",
    "ChatMessage",
    "TASK_DEBATE_REPLY",
    "TASK_REVIEW_CARD",
    "TASK_TOPIC",
    "TASK_EVENT_SCAN",
    "TASK_LOOP_DIALOG",
    "TASK_CANDIDATE",
    "TASK_ALTERNATIVE",
    "TASK_PRINCIPLE",
    "complete",
    "stream",
    "get_provider",
    "reset_providers",
    "extract_json",
    "provider_status",
]
