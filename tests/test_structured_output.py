"""对镜 · 结构化输出（schema 校验 + 失败重试 + 失败率）

在 2026-10-03 之前，所有「让模型返回 JSON」的任务都是同一套手写流程：
靠自然语言请求 JSON、靠手工兜底解析，**没有任何 schema 约束**。

其中一条已经真实可触发：

    topic = (payload.get("topic") or "").strip()
    # 模型返回 {"topic": 123} → AttributeError → 冒到全局处理器 → 500

这个文件守住四件事：
  · 类型错误被 schema 挡住，不再炸成 500
  · 不合法时会**带错误重试一次**（不是无脑重试）
  · 重试仍失败时有明确的降级行为，不编造数据
  · 失败率被统计（「JSON 解析成功率」是这个岗位的标准指标）
"""

from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from app.ai import structured
from app.ai.base import AIResponse, ChatMessage
from app.ai.structured import (
    EventCardAnalysis,
    ReviewPayload,
    ScanCandidates,
    TopicSuggestion,
    complete_json,
)
from app.services import ai_metrics


@pytest.fixture(autouse=True)
def _clean_metrics():
    ai_metrics.reset_for_tests()
    yield
    ai_metrics.reset_for_tests()


def _responder(*texts: str, finish_reason: str = "stop"):
    """按顺序返回预设文本，用来模拟「第一次不合法、第二次合法」。"""
    queue = list(texts)

    async def _fake(*args, **kwargs):
        text = queue.pop(0) if queue else ""
        return AIResponse(text=text, finish_reason=finish_reason)

    return _fake


class TestSchemaCatchesTypeErrors:
    def test_topic_rejects_non_string(self):
        """就是这个类型错误曾经会变成 500。"""
        with pytest.raises(ValidationError):
            TopicSuggestion.model_validate({"topic": 123})

        with pytest.raises(ValidationError):
            TopicSuggestion.model_validate({"topic": ["a", "b"]})

    def test_topic_accepts_missing_fields(self):
        """字段缺失要能容忍 —— 宽松是刻意的，别把格式瑕疵升级成失败。"""
        parsed = TopicSuggestion.model_validate({})
        assert parsed.topic == ""
        assert parsed.stance == ""

    def test_extra_keys_are_ignored(self):
        parsed = TopicSuggestion.model_validate({"topic": "t", "stance": "s", "why": "x"})
        assert parsed.topic == "t"

    def test_event_result_must_be_one_of_four(self):
        assert EventCardAnalysis.model_validate({"result": "hold"}).result == "hold"
        with pytest.raises(ValidationError):
            EventCardAnalysis.model_validate({"result": "撑住了"})

    def test_event_result_defaults_to_unsure(self):
        """拿不准时默认 unsure（方案 3.4：不确定就标待确认），绝不默认撑住。"""
        assert EventCardAnalysis.model_validate({}).result == "unsure"

    def test_string_advantage_is_recovered_not_dropped(self):
        """模型有时把观察写成字符串。

        旧代码用 `isinstance(value, dict)` 判断后**静默丢弃** ——
        那等于白扔一次模型输出。现在归一化，能救回来就救回来。
        """
        parsed = ReviewPayload.model_validate(
            {"good": "a", "advantage": "立场坚定", "weakness": "场景回避"}
        )
        assert parsed.advantage is not None and parsed.advantage.name == "立场坚定"
        assert parsed.weakness is not None and parsed.weakness.name == "场景回避"

    def test_scan_drops_non_object_items(self):
        """数组里混进非对象项时只丢那一项，不让整次扫描失败。

        注意 `{"nope": 1}` 会被normalize成 name=""，**由调用方过滤** ——
        schema 的职责是挡住类型错误，不是替业务判断「空名字算不算有效候选」。
        """
        parsed = ScanCandidates.model_validate(
            {"candidates": [{"name": "拖延"}, "怕否定", 42, {"nope": 1}]}
        )
        names = [c.name for c in parsed.candidates]
        assert names == ["拖延", "怕否定", ""], "数字项被丢弃，缺 name 的留空串"
        assert 42 not in [c.name for c in parsed.candidates]


class TestCompleteJsonRetry:
    def test_unparseable_then_valid_succeeds_on_retry(self, monkeypatch):
        monkeypatch.setattr(
            structured,
            "complete",
            _responder("抱歉，我无法完成这个任务。", '{"topic": "该不该当场反驳", "stance": "该"}'),
        )

        parsed, _ = asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )
        assert isinstance(parsed, TopicSuggestion)
        assert parsed.topic == "该不该当场反驳"

    def test_gives_up_after_one_retry(self, monkeypatch):
        """失败通常是 prompt 稳定地做不对，再试第三次只是重复同一个错误还多花钱。"""
        calls: list[int] = []

        async def counting(*args, **kwargs):
            calls.append(1)
            return AIResponse(text="完全不是 JSON", finish_reason="stop")

        monkeypatch.setattr(structured, "complete", counting)

        parsed, response = asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )
        assert parsed is None
        assert response is not None
        assert len(calls) == 2, f"应当只重试一次，实际调用 {len(calls)} 次"

    def test_truncated_output_is_treated_as_invalid(self, monkeypatch):
        """被 max_tokens 截断的 JSON 必然残缺，不该拿去解析。"""
        monkeypatch.setattr(
            structured,
            "complete",
            _responder('{"topic": "该不该', finish_reason="length"),
        )

        parsed, response = asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )
        assert parsed is None
        assert response is not None and response.truncated

    def test_retry_message_carries_the_reason(self, monkeypatch):
        """重试必须把「哪里不合法」告诉模型，否则就是无脑重发。"""
        seen: list[list[ChatMessage]] = []

        async def capture(task, messages, **kwargs):
            seen.append(list(messages))
            if len(seen) == 1:
                return AIResponse(text="不是 JSON", finish_reason="stop")
            return AIResponse(text='{"topic": "t"}', finish_reason="stop")

        monkeypatch.setattr(structured, "complete", capture)

        asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )

        assert len(seen) == 2
        assert len(seen[1]) > len(seen[0]), "重试时应把上一次输出与错误原因追加进去"
        assert "不合法" in seen[1][-1].content


class TestJsonFailureRateIsTracked:
    def test_attempts_and_calls_are_counted_separately(self, monkeypatch):
        """两组数回答两个不同的问题，不能混为一谈：

        · 按**尝试**：模型本身的合规度（改 prompt 时盯这个）
        · 按**逻辑调用**：用户的操作有没有失败（重试救回来的不算失败）
        """
        # 第一次调用：一次就成功（1 次尝试、1 次调用）
        # 第二次调用：两次都不合法（2 次尝试、1 次调用、且最终失败）
        monkeypatch.setattr(
            structured, "complete", _responder('{"topic": "ok"}', "坏输出", "坏输出")
        )

        asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )
        asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )

        live = ai_metrics.snapshot()
        # 3 次尝试里 2 次不合法
        assert live["json_attempts"] == 3
        assert live["json_failures"] == 2
        assert live["json_success_rate"] == pytest.approx(1 / 3, abs=1e-4)
        # 2 次逻辑调用里 1 次彻底失败
        assert live["json_calls"] == 2
        assert live["json_call_failures"] == 1
        assert live["json_call_success_rate"] == pytest.approx(0.5, abs=1e-6)
        assert live["json_failures_by_task"]["topic_generation"] == 2

    def test_retry_rescue_does_not_count_as_a_user_facing_failure(self, monkeypatch):
        """第一次不合法、重试成功 → 尝试失败率 50%，但用户成功率 100%。"""
        monkeypatch.setattr(
            structured, "complete", _responder("坏输出", '{"topic": "ok"}')
        )

        parsed, _ = asyncio.run(
            complete_json("topic_generation", [ChatMessage(role="user", content="x")], TopicSuggestion)
        )
        assert parsed is not None

        live = ai_metrics.snapshot()
        assert live["json_attempts"] == 2 and live["json_failures"] == 1
        assert live["json_calls"] == 1 and live["json_call_failures"] == 0
        assert live["json_call_success_rate"] == 1.0


class TestTopicGenerationNeverCrashes:
    def test_non_string_topic_falls_back_to_scene(self, monkeypatch):
        """端到端复现旧 bug：模型给数字时，生成辩题必须不抛异常。

        旧代码在这条路径上会 AttributeError → 500。
        """
        from app.services import debate as debate_service

        async def fake(*args, **kwargs):
            return AIResponse(text='{"topic": 123, "stance": 456}', finish_reason="stop")

        monkeypatch.setattr(structured, "complete", fake)

        topic, stance = asyncio.run(
            debate_service.generate_topic("开会被追问进度", debate_service.DebateContext())
        )
        assert topic == "开会被追问进度", "拿不到合法辩题时应退回用户自己的场景描述"
        assert isinstance(stance, str)

    def test_valid_topic_is_used(self, monkeypatch):
        from app.services import debate as debate_service

        async def fake(*args, **kwargs):
            return AIResponse(
                text='{"topic": "该不该当场回应", "stance": "该"}', finish_reason="stop"
            )

        monkeypatch.setattr(structured, "complete", fake)

        topic, stance = asyncio.run(
            debate_service.generate_topic("开会被追问进度", debate_service.DebateContext())
        )
        assert topic == "该不该当场回应"
        assert stance == "该"
