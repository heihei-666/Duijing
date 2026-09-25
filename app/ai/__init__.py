"""对镜 · AI 层

业务代码统一从这里导入，不要直接依赖具体 Provider。
"""

from app.ai.base import AIError, AIProvider, AIResponse, AIUsage, ChatMessage
from app.ai.router import (
    TASK_ALTERNATIVE,
    TASK_CANDIDATE,
    TASK_DEBATE_REPLY,
    TASK_EVENT_SCAN,
    TASK_LOOP_DIALOG,
    TASK_PRINCIPLE,
    TASK_REVIEW_CARD,
    TASK_TOPIC,
    complete,
    extract_json,
    get_provider,
    provider_status,
    stream,
)

__all__ = [
    "AIError",
    "AIProvider",
    "AIResponse",
    "AIUsage",
    "ChatMessage",
    "TASK_ALTERNATIVE",
    "TASK_CANDIDATE",
    "TASK_DEBATE_REPLY",
    "TASK_EVENT_SCAN",
    "TASK_LOOP_DIALOG",
    "TASK_PRINCIPLE",
    "TASK_REVIEW_CARD",
    "TASK_TOPIC",
    "complete",
    "extract_json",
    "get_provider",
    "provider_status",
    "stream",
]
