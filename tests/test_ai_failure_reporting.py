"""对镜 · AI 配置与失败的可诊断性

这个文件锁两件事，它们都是「AI 出问题时，系统说不说实话」：

1. `/api/health` 的 `ai.degraded` **必须按任务族分别判断**。
   旧实现是「只要有一个 Key 存在就不算降级」——于是 hybrid 模式下只配了
   DeepSeek Key 时，所有 MiMo 任务（复盘、辩题、扫描、回环对话、候选生成）
   都在跑 Mock，健康检查却一路绿灯。
   **同一份 Mock 内容在 API 响应里和真实输出长得一模一样**，
   所以这个字段是唯一能看出来的地方，它不能再撒谎。

2. AI 调用失败必须是 **502 + 一句能读的话**，不能是裸的 500。
   这个项目刻意不做「失败就换 Mock」的兜底（假观察会污染弱点库），
   所以失败会一路上抛——那至少要让调用方知道「是外部依赖挂了、可以重试」，
   而不是「服务器内部错误」。
"""

from __future__ import annotations

import pytest

from app.ai import router as router_module
from app.ai.base import AIError, AIResponse, ChatMessage
from app.ai.router import (
    TASK_DEBATE_REPLY,
    TASK_REVIEW_CARD,
    provider_status,
)


@pytest.fixture
def configured(monkeypatch):
    """改 AI 配置的便捷入口（用完自动还原，并重建 provider 单例）。"""

    def _apply(**kwargs):
        for key, value in kwargs.items():
            monkeypatch.setattr(router_module.settings, key, value)
        router_module.reset_providers()

    yield _apply
    router_module.reset_providers()


class TestDegradedIsPerTaskFamily:
    def test_hybrid_with_only_deepseek_key_is_degraded(self, configured):
        """这是修复前会挂的用例：结构化任务在跑 Mock，但 degraded 报 False。"""
        configured(AI_PROVIDER="hybrid", DEEPSEEK_API_KEY="sk-real", MIMO_API_KEY="")

        status = provider_status()
        assert status["degraded"] is True, "有任务在跑 Mock，就不能报「健康」"
        assert status["debate_provider"] == "deepseek"
        assert status["structured_provider"] == "mock"
        assert any("review" in t for t in status["degraded_tasks"])

    def test_hybrid_with_only_mimo_key_is_degraded(self, configured):
        """镜像情况：辩论房在跑 Mock（这个更严重，辩论是核心功能）。"""
        configured(AI_PROVIDER="hybrid", DEEPSEEK_API_KEY="", MIMO_API_KEY="mimo-real")

        status = provider_status()
        assert status["degraded"] is True
        assert status["debate_provider"] == "mock"
        assert status["structured_provider"] == "mimo"
        assert "debate_reply" in status["degraded_tasks"]

    def test_hybrid_with_both_keys_is_healthy(self, configured):
        configured(AI_PROVIDER="hybrid", DEEPSEEK_API_KEY="sk-real", MIMO_API_KEY="mimo-real")

        status = provider_status()
        assert status["degraded"] is False
        assert status["degraded_tasks"] == []
        assert status["debate_provider"] == "deepseek"
        assert status["structured_provider"] == "mimo"

    def test_mock_mode_is_not_reported_as_degraded(self, configured):
        """mock 是**明确选择**的运行模式，不是降级 —— 开发/演示都靠它。"""
        configured(AI_PROVIDER="mock", DEEPSEEK_API_KEY="", MIMO_API_KEY="")

        status = provider_status()
        assert status["degraded"] is False
        assert status["degraded_tasks"] == []
        assert status["debate_provider"] == "mock"

    def test_no_keys_with_hybrid_is_degraded(self, configured):
        """保留旧行为：两个 Key 都没有时当然算降级。"""
        configured(AI_PROVIDER="hybrid", DEEPSEEK_API_KEY="", MIMO_API_KEY="")
        assert provider_status()["degraded"] is True

    def test_single_provider_mode_uses_it_for_everything(self, configured):
        configured(AI_PROVIDER="deepseek", DEEPSEEK_API_KEY="sk-real", MIMO_API_KEY="")
        status = provider_status()
        assert status["debate_provider"] == "deepseek"
        assert status["structured_provider"] == "deepseek"
        assert status["degraded"] is False

    def test_health_endpoint_exposes_the_same_view(self, client, configured):
        """`/api/health` 是运维唯一会看的地方，字段必须对得上。"""
        configured(AI_PROVIDER="hybrid", DEEPSEEK_API_KEY="sk-real", MIMO_API_KEY="")

        body = client.get("/api/health").json()
        assert body["ai"]["degraded"] is True
        assert body["ai"]["structured_provider"] == "mock"
        assert body["ai"]["degraded_tasks"], "要能看出是哪类任务在跑假数据"


class TestAIErrorBecomes502:
    def test_ai_failure_returns_502_not_500(self, client, unique_name, monkeypatch):
        """让模型调用抛 AIError，接口应当回 502 + 可读信息。"""
        from app.api import debates as debates_api

        async def boom(*args, **kwargs):
            raise AIError("deepseek 网络请求失败：超时")

        # 建辩论时会立刻生成开场白，这条路径足够短
        monkeypatch.setattr(debates_api.debate_service, "generate_opening", boom)

        from tests.conftest import register

        actor = register(client, unique_name("ai502"))
        resp = actor.post("/api/debates", json={"topic": "该不该当场反驳", "stance": "该"})

        assert resp.status_code == 502, f"期望 502，实际 {resp.status_code}：{resp.text}"
        assert "重试" in resp.json()["detail"], "要告诉用户可以重试，而不是「服务器内部错误」"

    def test_health_still_ok_when_ai_configured_but_upstream_down(self, client):
        """健康检查探的是**本机与数据库**，不该因为模型服务挂了就报 down —— 
        否则监控会以为整台机器出事。模型状态单独在 ai 字段里看。"""
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert "ai" in body
