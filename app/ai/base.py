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
    ) -> AIResponse:
        """一次性返回完整结果。用于复盘、扫描、生成类任务。"""
        ...

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
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

    async def complete(self, messages, *, model=None, temperature=0.7, max_tokens=2048) -> AIResponse:
        return await self._complete_impl(
            messages, model=model or self.default_model, temperature=temperature, max_tokens=max_tokens
        )

    def stream(self, messages, *, model=None, temperature=0.7, max_tokens=2048) -> AsyncIterator[str]:
        return self._stream_impl(
            messages, model=model or self.default_model, temperature=temperature, max_tokens=max_tokens
        )

    async def _complete_impl(self, messages, *, model, temperature, max_tokens) -> AIResponse:
        raise NotImplementedError

    def _stream_impl(self, messages, *, model, temperature, max_tokens) -> AsyncIterator[str]:
        raise NotImplementedError
