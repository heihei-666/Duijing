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

# 哪些任务保留思考模式。
#
# 只有辩论房需要：它是实时对抗，论证质量直接决定产品价值。
# 其余任务都是「结构化短输出」（输出 JSON 或一两句话），
# 而两个模型都默认开思考、effort=high，推理 token 与正式输出**共用** max_tokens 预算——
# 实测给复盘卡片设 700 token，推理把预算吃光后 content 返回空串，
# 复盘卡片变成空白却不报错。关掉思考既避免这个坑，也省下推理部分的输出费用。
THINKING_TASKS = frozenset({TASK_DEBATE_REPLY})

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
    # 调用方没显式指定时，按任务性质决定是否开思考
    kwargs.setdefault("thinking", task in THINKING_TASKS)

    # 这里**刻意不做 Mock 兜底**。
    #
    # 曾经的写法是「真实模型失败就悄悄换成 Mock」，看起来更「健壮」，实际很危险：
    # 超时或报错时用户会拿到一段**看起来很像真的**模拟观察，
    # 而它会被当成 AI 的真实判断写进弱点库——这个产品最不能脏的就是这份数据。
    # 宁可显式失败让用户重试，也不要产生看似正常的假数据。
    #
    # 「没配 Key」是另一回事：那属于明确的降级模式，在选 Provider 时就决定了，
    # 并且可以通过 GET /api/health 的 ai.degraded 看到。
    return await provider.complete(messages, **kwargs)


def stream(task: str, messages: list[ChatMessage], **kwargs):
    """返回异步生成器。

    与 complete 同理：真实模型失败时直接向上抛，
    让 SSE 端点发出 error 事件、前端提示重试，
    而不是把 Mock 生成的辩词当成 AI 的真实回应接着往下辩。
    """
    provider = get_provider(task)
    kwargs.setdefault("thinking", task in THINKING_TASKS)
    return provider.stream(messages, **kwargs)


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


def _resolve_provider_name(mode: str, *, needs_reasoning: bool) -> str:
    """按当前配置算出**这类任务实际会用到**的 provider。

    抽出来是为了让 `/api/health` 和 `get_provider()` 用同一套判断，
    避免两处各写一遍然后慢慢漂移。
    """
    deepseek_ok = bool(settings.DEEPSEEK_API_KEY)
    mimo_ok = bool(settings.MIMO_API_KEY)

    if mode == "mock":
        return "mock"
    if mode == "deepseek":
        return "deepseek" if deepseek_ok else "mock"
    if mode == "mimo":
        return "mimo" if mimo_ok else "mock"
    if mode == "hybrid":
        if needs_reasoning:
            return "deepseek" if deepseek_ok else "mock"
        return "mimo" if mimo_ok else "mock"
    # 未知取值：get_provider() 也会回退到 mock，这里保持一致
    return "mock"


def provider_status() -> dict:
    """给 /api/health 用的诊断信息，不泄露 Key 本身。

    【这里曾经是错的，改动前请先读】

    原来的写法是：

        "degraded": settings.AI_PROVIDER != "mock"
        and not (settings.DEEPSEEK_API_KEY or settings.MIMO_API_KEY)

    只要**任意一个** Key 存在，`degraded` 就是 False。
    于是在 `hybrid` 模式下只配了 DeepSeek Key 时：
    所有走 MiMo 的任务（复盘、辩题、事件卡扫描、回环对话、候选生成）
    全部静默降级成 Mock，而 `/api/health` 一路报告「健康」。

    这恰好违反了这个项目自己最看重的原则 —— 「宁可显式失败，
    也不要产生看起来像真的假数据」。运行时确实不造假了，但配置这条路径上
    还有一个洞：Mock 的内容在 API 响应里和真实输出**看起来完全一样**。

    现在改成**按任务族分别判断**，并额外给出 `degraded_tasks`，
    让「哪一类任务在跑假数据」变得可见。
    """
    mode = settings.AI_PROVIDER
    deepseek_configured = bool(settings.DEEPSEEK_API_KEY)
    mimo_configured = bool(settings.MIMO_API_KEY)

    # 辩论房对话走推理模型，其余都是结构化短输出 —— 对应 REASONING_TASKS 的划分
    debate_provider = _resolve_provider_name(mode, needs_reasoning=True)
    structured_provider = _resolve_provider_name(mode, needs_reasoning=False)

    degraded_tasks: list[str] = []
    if mode != "mock":
        if debate_provider == "mock":
            degraded_tasks.append("debate_reply")
        if structured_provider == "mock":
            degraded_tasks.append("review/topic/scan/loop_dialog/candidate")

    return {
        "mode": mode,
        "deepseek_configured": deepseek_configured,
        "deepseek_model": settings.DEEPSEEK_MODEL,
        "mimo_configured": mimo_configured,
        "mimo_model": settings.MIMO_MODEL,
        # 两类任务各自实际会用到谁
        "debate_provider": debate_provider,
        "structured_provider": structured_provider,
        # 只要**有任何一类**任务在跑 Mock，就算降级
        "degraded": bool(degraded_tasks),
        "degraded_tasks": degraded_tasks,
    }


__all__ = [
    "THINKING_TASKS",
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
