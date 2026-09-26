"""对镜 · 真实模型 Provider

DeepSeek 与 MiMo 都提供 OpenAI 兼容接口，因此共用一套实现。

    DeepSeek  https://api.deepseek.com/chat/completions        模型 deepseek-flash
    MiMo      https://api.xiaomimimo.com/v1/chat/completions   模型 mimo-v2.6-flash

成本控制（方案第五章）：
  · 缓存前缀靠「首条 system 消息逐字一致」命中，这里不做任何改写
  · 结构化短输出任务关闭思考模式，见下面的「思考模式」说明

【思考模式 —— 实测结论，改动前务必先读】

DeepSeek V4.1 Flash 与 MiMo V2.6 Flash **都默认开启思考模式**，
回复里因此有两个字段：
    reasoning_content  思维链
    content            正式输出
**两者共用同一个 max_tokens 预算**，推理 token 也按输出计费。

实测踩到的坑：给复盘卡片设 max_tokens=700，结果推理把预算吃光，
content 返回空串、finish_reason=length —— 复盘卡片变成空白且不报错。

因此这里的策略是：
  · 结构化/短输出任务（复盘、辩题、扫描、回环对话、替代动作、原则提炼）
    → thinking=False，把预算全部留给正式输出
  · 辩论房对话（需要深度推理）
    → 保持思考模式开启，并给足 max_tokens

关闭方式按官方文档：`{"thinking": {"type": "disabled"}}`。
注意顶层 `enable_thinking:false` **无效**（实测被忽略，推理照常进行）。

另：思考模式下 `temperature` 会被静默忽略（官方说明「不报错也不生效」），
所以辩论房的 temperature 实际不起作用——这是模型行为，不是配置错误。
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

    def _payload(
        self,
        messages: list[ChatMessage],
        model: str,
        temperature: float,
        max_tokens: int,
        stream: bool,
        thinking: bool | None = None,
        reasoning_effort: str | None = None,
    ) -> dict:
        payload: dict = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }
        # 思考模式开关。None 表示跟随服务端默认（开启）。
        if thinking is not None:
            payload["thinking"] = {"type": "enabled" if thinking else "disabled"}
        if reasoning_effort:
            payload["reasoning_effort"] = reasoning_effort
        return payload

    async def _complete_impl(
        self, messages, *, model, temperature, max_tokens, thinking=None, reasoning_effort=None
    ) -> AIResponse:
        if not self.configured:
            raise AIError(f"{self.name} 未配置 API Key")

        payload = self._payload(
            messages, model, temperature, max_tokens, stream=False,
            thinking=thinking, reasoning_effort=reasoning_effort,
        )
        try:
            async with httpx.AsyncClient(timeout=settings.AI_TIMEOUT_SECONDS) as client:
                resp = await client.post(self._endpoint(), headers=self._headers(), json=payload)
        except httpx.HTTPError as exc:
            raise AIError(f"{self.name} 网络请求失败：{exc}") from exc

        if resp.status_code >= 400:
            raise AIError(f"{self.name} 返回 {resp.status_code}：{resp.text[:200]}")

        try:
            data = resp.json()
            choice = data["choices"][0]
            message = choice["message"]
            text = message.get("content") or ""
            reasoning = message.get("reasoning_content") or ""
            finish_reason = choice.get("finish_reason") or ""
        except (KeyError, IndexError, ValueError) as exc:
            raise AIError(f"{self.name} 响应格式异常") from exc

        # 被 max_tokens 截断且正式输出为空：这是最隐蔽的失败——
        # HTTP 200、无异常，但拿回来的是空串，上层如果直接落库就会写入一条空白记录。
        # 宁可显式报错让降级/重试逻辑接手，也不要静默返回空内容。
        if not text and finish_reason == "length":
            raise AIError(
                f"{self.name} 输出被 max_tokens={max_tokens} 截断且 content 为空"
                f"（推理消耗了全部预算，reasoning {len(reasoning)} 字）。"
                f"请关闭思考模式或调大 max_tokens。"
            )

        usage_raw = data.get("usage") or {}
        usage = AIUsage(
            prompt_tokens=int(usage_raw.get("prompt_tokens") or 0),
            completion_tokens=int(usage_raw.get("completion_tokens") or 0),
            cached_tokens=int(usage_raw.get("prompt_cache_hit_tokens") or 0),
            model=model,
        )
        return AIResponse(
            text=text.strip(),
            usage=usage,
            provider=self.name,
            finish_reason=finish_reason,
            reasoning=reasoning,
        )

    async def _stream_impl(
        self, messages, *, model, temperature, max_tokens, thinking=None, reasoning_effort=None
    ) -> AsyncIterator[str]:
        if not self.configured:
            raise AIError(f"{self.name} 未配置 API Key")

        payload = self._payload(
            messages, model, temperature, max_tokens, stream=True,
            thinking=thinking, reasoning_effort=reasoning_effort,
        )
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
