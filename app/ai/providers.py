"""对镜 · 真实模型 Provider

DeepSeek 与 MiMo 都提供 OpenAI 兼容接口，因此共用一套实现。

    DeepSeek  https://api.deepseek.com/chat/completions        模型 deepseek-flash
    MiMo      https://api.xiaomimimo.com/v1/chat/completions   模型 mimo-v2.6-flash

成本控制（方案第五章）：
  · 缓存前缀靠「首条 system 消息逐字一致」命中，这里不做任何改写
  · 非流式任务默认不开思考模式，减少输出 token
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from app.ai.base import AIError, AIResponse, AIUsage, BaseProvider, ChatMessage
from app.config import settings


class OpenAICompatibleProvider(BaseProvider):
    """OpenAI /chat/completions 协议的通用客户端。"""

    name = "openai-compatible"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _endpoint(self) -> str:
        return f"{self.base_url}/chat/completions"

    def _payload(self, messages: list[ChatMessage], model: str, temperature: float,
                 max_tokens: int, stream: bool) -> dict:
        return {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }

    async def _complete_impl(self, messages, *, model, temperature, max_tokens) -> AIResponse:
        if not self.configured:
            raise AIError(f"{self.name} 未配置 API Key")

        payload = self._payload(messages, model, temperature, max_tokens, stream=False)
        try:
            async with httpx.AsyncClient(timeout=settings.AI_TIMEOUT_SECONDS) as client:
                resp = await client.post(self._endpoint(), headers=self._headers(), json=payload)
        except httpx.HTTPError as exc:
            raise AIError(f"{self.name} 网络请求失败：{exc}") from exc

        if resp.status_code >= 400:
            raise AIError(f"{self.name} 返回 {resp.status_code}：{resp.text[:200]}")

        try:
            data = resp.json()
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, ValueError) as exc:
            raise AIError(f"{self.name} 响应格式异常") from exc

        usage_raw = data.get("usage") or {}
        usage = AIUsage(
            prompt_tokens=int(usage_raw.get("prompt_tokens") or 0),
            completion_tokens=int(usage_raw.get("completion_tokens") or 0),
            cached_tokens=int(usage_raw.get("prompt_cache_hit_tokens") or 0),
            model=model,
        )
        return AIResponse(text=text.strip(), usage=usage, provider=self.name)

    async def _stream_impl(self, messages, *, model, temperature, max_tokens) -> AsyncIterator[str]:
        if not self.configured:
            raise AIError(f"{self.name} 未配置 API Key")

        payload = self._payload(messages, model, temperature, max_tokens, stream=True)
        try:
            async with httpx.AsyncClient(timeout=settings.AI_TIMEOUT_SECONDS) as client:
                async with client.stream(
                    "POST", self._endpoint(), headers=self._headers(), json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        raise AIError(
                            f"{self.name} 返回 {resp.status_code}：{body.decode('utf-8', 'ignore')[:200]}"
                        )
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if chunk == "[DONE]":
                            break
                        try:
                            parsed = json.loads(chunk)
                        except ValueError:
                            continue
                        choices = parsed.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        piece = delta.get("content")
                        if piece:
                            yield piece
        except httpx.HTTPError as exc:
            raise AIError(f"{self.name} 流式请求失败：{exc}") from exc


class DeepSeekProvider(OpenAICompatibleProvider):
    """辩论房对话 —— 需要深度推理。"""

    name = "deepseek"

    def __init__(self) -> None:
        super().__init__(
            api_key=settings.DEEPSEEK_API_KEY,
            base_url=settings.DEEPSEEK_BASE_URL,
            model=settings.DEEPSEEK_MODEL,
        )


class MiMoProvider(OpenAICompatibleProvider):
    """结构化 / 短输出任务 —— 输出价格是 DeepSeek 的一半。"""

    name = "mimo"

    def __init__(self) -> None:
        super().__init__(
            api_key=settings.MIMO_API_KEY,
            base_url=settings.MIMO_BASE_URL,
            model=settings.MIMO_MODEL,
        )
