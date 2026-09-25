"""对镜 · AI 层测试

这里测的是**约束**，不是效果：
  · 缓存前缀必须从第一个字符开始完全一致（方案第九章第 3 条）
  · 弱点库摘要按 ID 排序
  · 路由规则不得更改（第九章第 2 条）
  · 结构化输出解析要能扛住真实模型的脏输出
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from app.ai import prompts
from app.ai.base import ChatMessage
from app.ai.mock import MockProvider
from app.ai.router import (
    REASONING_TASKS,
    TASK_DEBATE_REPLY,
    TASK_EVENT_SCAN,
    TASK_REVIEW_CARD,
    TASK_TOPIC,
    extract_json,
)


@dataclass
class FakeCard:
    id: int
    name: str
    description: str = ""
    domains: list = field(default_factory=list)
    confidence: int = 3
    status: str = "observing"


@dataclass
class FakeAdvantage:
    id: int
    name: str
    status: str = "confirmed"


@dataclass
class FakeLoop:
    trigger_scene: str = "开会被追问进度"
    body_signal: str = "心跳加快"
    action_plan: str = "先承认没想清楚"


# ─────────────────────────────────────────────────────────────
# 约束 3：缓存前缀稳定性
# ─────────────────────────────────────────────────────────────


class TestCachePrefix:
    def test_identical_across_calls(self):
        """同一场辩论内，前缀必须逐字节一致，否则缓存全部落空。"""
        cards = [FakeCard(2, "弱点B", domains=["work"]), FakeCard(1, "弱点A", domains=["emotion"])]
        advs = [FakeAdvantage(1, "临场反应快")]
        loop = FakeLoop()

        first = prompts.build_stable_system(cards, advs, loop, cards[0])
        second = prompts.build_stable_system(cards, advs, loop, cards[0])

        assert first == second
        assert first.startswith(prompts.FIXED_SYSTEM_PROMPT)  # 必须从第一个字符开始一致

    def test_weakness_summary_sorted_by_id(self):
        """输入顺序变了，输出不能变——按 ID 排序是硬性要求。"""
        ordered = [FakeCard(1, "甲"), FakeCard(2, "乙"), FakeCard(3, "丙")]
        shuffled = [FakeCard(3, "丙"), FakeCard(1, "甲"), FakeCard(2, "乙")]

        assert prompts.render_weakness_summary(ordered) == prompts.render_weakness_summary(shuffled)

        text = prompts.render_weakness_summary(shuffled)
        assert text.index("#1") < text.index("#2") < text.index("#3")

    def test_empty_libraries_use_placeholder_not_blank(self):
        """空库要给固定占位串。返回空字符串会让前缀长度漂移，缓存直接失效。"""
        text = prompts.build_stable_system([], [], None, None)
        assert "（暂无记录）" in text
        assert "（暂无已确认优势）" in text
        assert "本场未关联回环" in text

    def test_advantage_summary_only_confirmed(self):
        """方案 3.5：只有已确认的优势才在回环预案中被推荐。"""
        advs = [
            FakeAdvantage(1, "已确认的", status="confirmed"),
            FakeAdvantage(2, "待确认的", status="pending"),
            FakeAdvantage(3, "已归档的", status="archived"),
        ]
        text = prompts.render_advantage_summary(advs)

        assert "已确认的" in text
        assert "待确认的" not in text
        assert "已归档的" not in text

    def test_prompt_version_is_pinned(self):
        """版本号变更会让全部历史缓存失效，必须是有意识的改动。"""
        assert prompts.PROMPT_VERSION == "duijing-sys-v1"

    def test_debate_messages_stable_system_is_first(self):
        """可变内容绝不能混进第一条 system 消息。"""
        stable = prompts.build_stable_system([FakeCard(1, "甲")], [], None, None)
        messages = prompts.build_debate_messages(
            stable, "辩题X", "立场Y", [], "最新发言", level="novice"
        )
        assert messages[0].role == "system"
        assert messages[0].content == stable

        # 辩题这类可变内容只能在后面
        assert "辩题X" not in messages[0].content


# ─────────────────────────────────────────────────────────────
# 约束 2：路由规则
# ─────────────────────────────────────────────────────────────


class TestRouting:
    def test_only_debate_uses_reasoning_model(self):
        """辩论房走 DeepSeek，其余走 MiMo——不得更改。"""
        assert REASONING_TASKS == frozenset({TASK_DEBATE_REPLY})

    def test_hybrid_routing_picks_correct_provider(self, monkeypatch):
        from app.ai import router as router_module

        monkeypatch.setattr(router_module.settings, "AI_PROVIDER", "hybrid")
        monkeypatch.setattr(router_module.settings, "DEEPSEEK_API_KEY", "sk-fake")
        monkeypatch.setattr(router_module.settings, "MIMO_API_KEY", "sk-fake")
        router_module.reset_providers()

        assert router_module.get_provider(TASK_DEBATE_REPLY).name == "deepseek"
        assert router_module.get_provider(TASK_REVIEW_CARD).name == "mimo"
        assert router_module.get_provider(TASK_TOPIC).name == "mimo"
        assert router_module.get_provider(TASK_EVENT_SCAN).name == "mimo"

        router_module.reset_providers()

    def test_missing_key_degrades_to_mock_not_crash(self, monkeypatch):
        """Key 没配就降级，不能让辩论房直接 500。"""
        from app.ai import router as router_module

        monkeypatch.setattr(router_module.settings, "AI_PROVIDER", "hybrid")
        monkeypatch.setattr(router_module.settings, "DEEPSEEK_API_KEY", "")
        monkeypatch.setattr(router_module.settings, "MIMO_API_KEY", "")
        router_module.reset_providers()

        assert router_module.get_provider(TASK_DEBATE_REPLY).name == "mock"

        router_module.reset_providers()


# ─────────────────────────────────────────────────────────────
# 结构化输出解析
# ─────────────────────────────────────────────────────────────


class TestExtractJson:
    def test_plain_json(self):
        assert extract_json('{"a": 1}') == {"a": 1}

    def test_fenced_json(self):
        raw = '好的，这是结果：\n```json\n{"topic": "辩题", "stance": "立场"}\n```'
        assert extract_json(raw)["topic"] == "辩题"

    def test_fence_without_language_tag(self):
        assert extract_json('```\n{"a": 2}\n```') == {"a": 2}

    def test_json_embedded_in_prose(self):
        raw = '我认为应该这样：{"loop_id": 5, "result": "hold"} 就这样。'
        parsed = extract_json(raw)
        assert parsed["loop_id"] == 5
        assert parsed["result"] == "hold"

    def test_nested_braces(self):
        raw = '{"a": {"b": {"c": 1}}, "d": 2}'
        assert extract_json(raw)["a"]["b"]["c"] == 1

    def test_brace_inside_string_not_confused(self):
        raw = '{"note": "这里有个 } 花括号", "ok": true}'
        parsed = extract_json(raw)
        assert parsed["ok"] is True
        assert "花括号" in parsed["note"]

    @pytest.mark.parametrize("raw", ["", "完全不是 JSON", "null", "[1,2,3]"])
    def test_invalid_returns_none(self, raw):
        assert extract_json(raw) is None


# ─────────────────────────────────────────────────────────────
# Mock Provider
# ─────────────────────────────────────────────────────────────


class TestMockProvider:
    @pytest.mark.asyncio
    async def test_review_output_is_valid_json_with_capped_observations(self):
        """Mock 也必须遵守「最多 1 优势 + 1 弱点」的产出结构，
        否则测试跑通而线上跑挂。"""
        provider = MockProvider(stream_delay=0)
        messages = prompts.build_review_messages(
            "该不该当场反驳",
            "该",
            "AI：你的依据是什么？\n用户：因为我试过\nAI：还有吗？\n用户：暂时没有了",
        )
        response = await provider.complete(messages)
        payload = extract_json(response.text)

        assert payload is not None
        assert set(["good", "notice", "next_time", "alternative_action"]).issubset(payload)
        assert isinstance(payload["advantage"], (dict, type(None)))
        assert isinstance(payload["weakness"], (dict, type(None)))

    @pytest.mark.asyncio
    async def test_topic_output_is_valid_json(self):
        provider = MockProvider(stream_delay=0)
        messages = prompts.build_topic_messages("开会时被领导当众追问进度")
        payload = extract_json((await provider.complete(messages)).text)

        assert payload is not None
        assert payload["topic"]
        assert payload["stance"]

    @pytest.mark.asyncio
    async def test_scan_returns_empty_when_too_few_cards(self):
        """证据不足时应该返回空数组，而不是硬编造弱点。"""
        provider = MockProvider(stream_delay=0)
        messages = prompts.build_event_scan_messages("- 只有一条记录")
        payload = extract_json((await provider.complete(messages)).text)
        assert payload["candidates"] == []

    @pytest.mark.asyncio
    async def test_short_debate_yields_no_observations(self):
        """记录太少时不给观察——不编造。"""
        provider = MockProvider(stream_delay=0)
        messages = prompts.build_review_messages("辩题", "立场", "用户：只有一句")
        payload = extract_json((await provider.complete(messages)).text)
        assert payload["advantage"] is None
        assert payload["weakness"] is None

    @pytest.mark.asyncio
    async def test_stream_concatenates_to_complete_text(self):
        provider = MockProvider(stream_delay=0)
        messages = [
            ChatMessage(role="system", content=prompts.FIXED_SYSTEM_PROMPT),
            ChatMessage(role="user", content="我认为应该直接反驳"),
        ]
        chunks = [piece async for piece in provider.stream(messages)]
        assert len(chunks) > 1  # 确实是分块的
        assert "".join(chunks) == (await provider.complete(messages)).text

    @pytest.mark.asyncio
    async def test_loop_dialog_uses_spec_question(self):
        """对话式回环的四步问法在方案 3.3 里是写死的，Mock 必须一致。"""
        provider = MockProvider(stream_delay=0)
        messages = prompts.build_loop_dialog_messages("被追问时防御", "confirm", {})
        text = (await provider.complete(messages)).text
        assert "启用" in text


# ─────────────────────────────────────────────────────────────
# 限流（方案 7.9）
# ─────────────────────────────────────────────────────────────


class TestRateLimiter:
    """整套 API 测试把阈值放开了，所以限流逻辑必须在这里单独验证，
    否则这条安全策略就成了没人守的代码。"""

    def test_allows_up_to_limit_then_blocks(self):
        from app.services.ratelimit import SlidingWindowLimiter

        limiter = SlidingWindowLimiter(window_seconds=60)
        for _ in range(10):
            assert limiter.allow("user:1", 10) is True
        assert limiter.allow("user:1", 10) is False

    def test_keys_are_isolated(self):
        from app.services.ratelimit import SlidingWindowLimiter

        limiter = SlidingWindowLimiter(window_seconds=60)
        for _ in range(10):
            limiter.allow("user:1", 10)
        # 另一个用户不受影响
        assert limiter.allow("user:2", 10) is True

    def test_retry_after_positive_when_limited(self):
        from app.services.ratelimit import SlidingWindowLimiter

        limiter = SlidingWindowLimiter(window_seconds=60)
        for _ in range(3):
            limiter.allow("k", 3)
        assert limiter.retry_after("k", 3) > 0
        assert limiter.retry_after("untouched", 3) == 0

    def test_window_expiry_frees_slots(self):
        from app.services.ratelimit import SlidingWindowLimiter

        # 用极短窗口模拟时间流逝，避免测试真的睡 60 秒
        limiter = SlidingWindowLimiter(window_seconds=0)
        for _ in range(5):
            limiter.allow("k", 2)
        assert limiter.allow("k", 2) is True

    def test_lockout_after_repeated_failures(self):
        from app.services.ratelimit import FailureLockout

        lockout = FailureLockout(threshold=5, lock_minutes=15)
        for _ in range(4):
            lockout.record_failure("1.2.3.4")
        assert lockout.is_locked("1.2.3.4") == 0  # 还没到阈值

        lockout.record_failure("1.2.3.4")
        assert lockout.is_locked("1.2.3.4") > 0  # 第 5 次触发锁定

    def test_successful_login_clears_failures(self):
        from app.services.ratelimit import FailureLockout

        lockout = FailureLockout(threshold=3, lock_minutes=15)
        lockout.record_failure("ip")
        lockout.record_failure("ip")
        lockout.reset("ip")
        lockout.record_failure("ip")
        assert lockout.is_locked("ip") == 0

    def test_client_ip_prefers_forwarded_header(self):
        """Nginx 反代下必须读 X-Forwarded-For，否则所有用户共用一个 IP 配额。"""
        from app.services.ratelimit import client_ip

        class FakeRequest:
            headers = {"X-Forwarded-For": "203.0.113.7, 10.0.0.1"}
            client = None

        assert client_ip(FakeRequest()) == "203.0.113.7"
