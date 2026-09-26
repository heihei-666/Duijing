"""对镜 · AI Provider 抽象

设计目标：业务代码只依赖这里的协议，不关心背后是 Mock 还是真实模型。
切换只需改环境变量 AI_PROVIDER，不改一行业务逻辑。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass(slots=True)
class ChatMessage:
    role: str  # system | user | assistant
    content: str


@dataclass(slots=True)
class AIUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    model: str = ""

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass(slots=True)
class AIResponse:
    text: str
    usage: AIUsage = field(default_factory=AIUsage)
    provider: str = ""
    # stop / length / content_filter ...。length 表示被 max_tokens 截断，
    # 此时结构化任务的 JSON 必然是残缺的，调用方必须当成失败处理，不能拿去解析。
    finish_reason: str = ""
    # 思维链。只用于诊断与成本观测，绝不落业务表——
    # 用户不该看到模型的思考过程，那是「后台」而不是「产品」。
    reasoning: str = ""

    @property
    def truncated(self) -> bool:
        return self.finish_reason == "length"


class AIError(RuntimeError):
    """AI 调用失败。业务层捕获后给出降级文案，不要让 500 冒到前端。"""


@runtime_checkable
class AIProvider(Protocol):
    name: str

    async def complete(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        thinking: bool | None = None,
        reasoning_effort: str | None = None,
    ) -> AIResponse:
        """一次性返回完整结果。用于复盘、扫描、生成类任务。

        thinking=False 会关闭思考模式。**对结构化短输出任务必须关**：
        模型默认开思考且 effort=high，推理 token 与正式输出共用 max_tokens 预算，
        不关的话很容易出现「budget 被推理吃光、content 返回空串」的情况。
        """
        ...

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        thinking: bool | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[str]:
        """流式返回增量文本。用于辩论房 SSE。"""
        ...


class BaseProvider:
    """提供一点公共默认值，子类只需实现 _complete_impl / _stream_impl。"""

    name = "base"
    default_model = ""

    def __init__(self, api_key: str = "", base_url: str = "", model: str = "") -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.default_model = model or self.default_model

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def complete(
        self, messages, *, model=None, temperature=0.7, max_tokens=2048,
        thinking=None, reasoning_effort=None,
    ) -> AIResponse:
        return await self._complete_impl(
            messages,
            model=model or self.default_model,
            temperature=temperature,
            max_tokens=max_tokens,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
        )

    def stream(
        self, messages, *, model=None, temperature=0.7, max_tokens=2048,
        thinking=None, reasoning_effort=None,
    ) -> AsyncIterator[str]:
        return self._stream_impl(
            messages,
            model=model or self.default_model,
            temperature=temperature,
            max_tokens=max_tokens,
            thinking=thinking,
            reasoning_effort=reasoning_effort,
        )

    async def _complete_impl(
        self, messages, *, model, temperature, max_tokens, thinking=None, reasoning_effort=None
    ) -> AIResponse:
        raise NotImplementedError

    def _stream_impl(
        self, messages, *, model, temperature, max_tokens, thinking=None, reasoning_effort=None
    ) -> AsyncIterator[str]:
        raise NotImplementedError
