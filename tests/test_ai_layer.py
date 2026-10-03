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
        """版本号变更会让全部历史缓存失效，必须是有意识的改动。

        原来的写法是硬编码 `== "duijing-sys-v1"`。加了复盘 prompt 的 A/B 之后，
        版本号由 `REVIEW_PROMPT_VERSION` 派生 —— 所以这里改成守**派生关系**，
        而不是守某个具体字符串。原意（版本必须显式、改动必须是有意识的）不变。
        """
        assert prompts.PROMPT_VERSION == f"duijing-sys-{prompts.REVIEW_PROMPT_VERSION}"
        assert prompts.PROMPT_VERSION.startswith("duijing-sys-")

    def test_review_prompt_versions_are_actually_different(self):
        """两版复盘 prompt 必须是**真的不同**。

        否则 A/B 会跑出两份一模一样的报告，还让人以为做了对比 ——
        这种「看起来在评测」的假象比没有评测更糟。
        """
        assert prompts._REVIEW_SYSTEM_V1 != prompts._REVIEW_SYSTEM_V2

        # v2 承诺改进的三件事，逐条验证它真的写了
        v2 = prompts._REVIEW_SYSTEM_V2
        assert "论证结构" in v2, "v2 必须给出观察四层（v1 完全没有，是错标的主因）"
        assert "立场坚定" in v2, "v2 必须把「立场坚定」这类空标签明确列出来"
        assert "原样引用" in v2, "v2 必须要求 reason 引用用户原话（可验证的硬约束）"

    def test_review_prompt_version_selectable_by_env(self, monkeypatch):
        """A/B 靠环境变量切换，两条分支都要能走通。"""
        import importlib

        for want in ("v1", "v2"):
            monkeypatch.setenv("REVIEW_PROMPT_VERSION", want)
            reloaded = importlib.reload(prompts)
            assert reloaded.REVIEW_PROMPT_VERSION == want
            assert reloaded.PROMPT_VERSION == f"duijing-sys-{want}"
            messages = reloaded.build_review_messages("辩题", "该", "【第1轮】用户：x")
            expected = (
                reloaded._REVIEW_SYSTEM_V1 if want == "v1" else reloaded._REVIEW_SYSTEM_V2
            )
            assert messages[0].content.startswith(expected[:60])

        monkeypatch.delenv("REVIEW_PROMPT_VERSION", raising=False)
        importlib.reload(prompts)

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


# ─────────────────────────────────────────────────────────────
# 思考模式控制（真实模型实测踩出来的坑）
# ─────────────────────────────────────────────────────────────


class TestThinkingMode:
    """DeepSeek 与 MiMo 都默认开启思考模式，且 reasoning_content 与 content
    **共用同一个 max_tokens 预算**。

    实测：给复盘卡片设 max_tokens=700，推理把预算吃光，content 返回空串、
    finish_reason=length，HTTP 却是 200 —— 失败完全静默，复盘卡片会变成空白。
    """

    def test_only_debate_keeps_thinking(self):
        from app.ai.router import THINKING_TASKS, TASK_DEBATE_REPLY, TASK_REVIEW_CARD

        assert THINKING_TASKS == frozenset({TASK_DEBATE_REPLY})
        assert TASK_REVIEW_CARD not in THINKING_TASKS

    def test_payload_encodes_thinking_flag(self):
        """关闭思考必须走官方参数 thinking.type，
        顶层 enable_thinking 实测被服务端忽略。"""
        from app.ai.providers import DeepSeekProvider

        provider = DeepSeekProvider()
        messages = [ChatMessage(role="user", content="hi")]

        off = provider._payload(messages, "m", 0.7, 100, False, thinking=False)
        assert off["thinking"] == {"type": "disabled"}
        assert "enable_thinking" not in off

        on = provider._payload(messages, "m", 0.7, 100, False, thinking=True)
        assert on["thinking"] == {"type": "enabled"}

        # 不传就完全不带这个字段，跟随服务端默认
        default = provider._payload(messages, "m", 0.7, 100, False)
        assert "thinking" not in default

    def test_reasoning_effort_only_when_specified(self):
        from app.ai.providers import MiMoProvider

        provider = MiMoProvider()
        messages = [ChatMessage(role="user", content="hi")]

        assert "reasoning_effort" not in provider._payload(messages, "m", 0.7, 100, False)
        payload = provider._payload(messages, "m", 0.7, 100, False, reasoning_effort="low")
        assert payload["reasoning_effort"] == "low"

    def test_truncated_response_is_flagged(self):
        """被截断必须能被上层识别——截断的 JSON 解析出来是 None，
        如果当成正常结果落库，就会写入一条空白复盘。"""
        from app.ai.base import AIResponse

        assert AIResponse(text="", finish_reason="length").truncated is True
        assert AIResponse(text="ok", finish_reason="stop").truncated is False

    def test_truncated_empty_output_raises_instead_of_returning_blank(self):
        """最隐蔽的失败模式：HTTP 200、无异常、content 为空。
        必须显式报错，不能静默返回空串。"""
        import asyncio

        from app.ai.base import AIError
        from app.ai.providers import MiMoProvider

        provider = MiMoProvider()
        provider.api_key = "fake-key-for-test"

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "choices": [
                        {
                            "finish_reason": "length",
                            "message": {"content": "", "reasoning_content": "想了很久" * 50},
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 700},
                }

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                return FakeResponse()

        import app.ai.providers as providers_module

        original = providers_module.httpx.AsyncClient
        providers_module.httpx.AsyncClient = lambda *a, **kw: FakeClient()
        try:
            with pytest.raises(AIError, match="截断"):
                asyncio.run(provider.complete([ChatMessage(role="user", content="x")]))
        finally:
            providers_module.httpx.AsyncClient = original


class TestNoSilentMockFallback:
    """真实模型失败时**不能**悄悄换成 Mock 内容。

    否则超时那一刻，用户会拿到一段看起来很像真的模拟观察，
    而它会被当作 AI 的真实判断写进弱点库——这个产品最不能脏的就是这份数据。
    """

    def test_complete_raises_instead_of_falling_back(self, monkeypatch):
        import asyncio

        from app.ai import router as router_module
        from app.ai.base import AIError

        class ExplodingProvider:
            name = "exploding"
            default_model = "x"
            configured = True

            async def complete(self, *a, **kw):
                raise AIError("上游超时")

            def stream(self, *a, **kw):
                raise AIError("上游超时")

        monkeypatch.setattr(router_module, "get_provider", lambda task: ExplodingProvider())

        with pytest.raises(AIError):
            asyncio.run(
                router_module.complete(TASK_REVIEW_CARD, [ChatMessage(role="user", content="x")])
            )

    def test_stream_raises_instead_of_falling_back(self, monkeypatch):
        from app.ai import router as router_module
        from app.ai.base import AIError

        class ExplodingProvider:
            name = "exploding"
            default_model = "x"
            configured = True

            def stream(self, *a, **kw):
                raise AIError("上游超时")

        monkeypatch.setattr(router_module, "get_provider", lambda task: ExplodingProvider())

        with pytest.raises(AIError):
            router_module.stream(TASK_DEBATE_REPLY, [ChatMessage(role="user", content="x")])

    def test_mock_still_used_when_key_missing(self, monkeypatch):
        """「没配 Key」是另一回事：那是明确的降级模式，
        在选 Provider 阶段就决定，并且能从 /api/health 看到。"""
        from app.ai import router as router_module

        monkeypatch.setattr(router_module.settings, "AI_PROVIDER", "hybrid")
        monkeypatch.setattr(router_module.settings, "DEEPSEEK_API_KEY", "")
        monkeypatch.setattr(router_module.settings, "MIMO_API_KEY", "")
        router_module.reset_providers()

        assert router_module.get_provider(TASK_REVIEW_CARD).name == "mock"
        assert router_module.provider_status()["degraded"] is True

        router_module.reset_providers()


class TestReviewGenerationHonesty:
    """复盘生成失败时要报错，不能填通用鼓励语冒充 AI 观察。

    2026-10-03 起复盘走 `app.ai.structured.complete_json`
    （schema 校验 + 失败重试一次），所以打桩位置从 `debate_service.complete`
    换成了 `structured.complete` —— 被测的行为没变，注入点变了。
    """

    def test_review_raises_when_json_unparseable(self, monkeypatch):
        import asyncio

        from app.ai import structured
        from app.ai.base import AIResponse
        from app.services import debate as debate_service

        calls: list[int] = []

        async def fake_complete(*a, **kw):
            calls.append(1)
            return AIResponse(text="抱歉，我无法完成这个任务。", finish_reason="stop")

        monkeypatch.setattr(structured, "complete", fake_complete)

        class FakeRoom:
            id = 1
            user_id = 1
            topic = "t"
            stance = "s"

        class FakeSession:
            async def scalar(self, *a, **kw):
                return None

            def add(self, *a, **kw):
                pass

            async def flush(self):
                pass

            async def execute(self, *a, **kw):
                class R:
                    @staticmethod
                    def scalars():
                        class S:
                            @staticmethod
                            def all():
                                return []

                        return S()

                return R()

        with pytest.raises(debate_service.ReviewGenerationError):
            asyncio.run(
                debate_service.generate_review(
                    FakeSession(), FakeRoom(), debate_service.DebateContext()
                )
            )

        # 重试确实发生了：解析不了的内容值得再试一次（用户刚白辩了一场）
        assert len(calls) == 2, f"应当重试一次，实际调用了 {len(calls)} 次"

    def test_missing_blocks_stay_empty_not_fabricated(self):
        """结构性字段缺失时留空，不填放到谁身上都成立的废话。

        这个保证现在落在 **schema 的默认值**上（`ReviewPayload`），
        所以这里断言 schema 行为，而不是去源码里搜 `_text(...)` 调用。
        行为断言比源码文本断言强：它测的是「给定空 JSON 会得到什么」，
        而不是「代码长什么样」。
        """
        from app.ai.structured import ReviewPayload

        parsed = ReviewPayload.model_validate({})
        for field in ("good", "notice", "next_time", "alternative_action"):
            assert getattr(parsed, field) == "", (
                f"{field} 的默认值是 {getattr(parsed, field)!r}，应当留空——"
                f"通用鼓励语会被用户误认为 AI 的真实观察"
            )
        assert parsed.advantage is None
        assert parsed.weakness is None

    def test_review_fields_are_taken_from_the_payload_verbatim(self):
        """再补一道源码级护栏：落库时必须直接取 payload 字段，
        不能出现 `payload.good or "你完整走完了这场辩论"` 这类兜底。"""
        import ast
        import inspect
        import textwrap

        from app.services import debate as debate_service

        tree = ast.parse(textwrap.dedent(inspect.getsource(debate_service.generate_review)))

        assigned: set[str] = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Assign)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute)
                and node.value.func.attr == "strip"
                and isinstance(node.value.func.value, ast.Attribute)
                and isinstance(node.value.func.value.value, ast.Name)
                and node.value.func.value.value.id == "payload"
            ):
                for target in node.targets:
                    if isinstance(target, ast.Attribute):
                        assigned.add(target.attr)

        for field in ("good", "notice", "next_time", "alternative_action"):
            assert field in assigned, f"review.{field} 应当直接取自 payload.{field}"


# ─────────────────────────────────────────────────────────────
# 人格与上下文必须解耦（真实模型实测踩出来的坑）
# ─────────────────────────────────────────────────────────────


class TestPersonaIsolation:
    """复盘调用曾经把辩论人格一起传过去，模型于是继续辩论，
    返回一段辩词而不是复盘 JSON —— 复盘永远解析失败。

    根因：build_stable_system() 里含「你是辩论对手」那段固定 Prompt，
    而复盘需要的是**用户档案**，不是辩论人格。两者必须能分开取。
    """

    def test_context_blocks_exclude_debate_persona(self):
        cards = [FakeCard(1, "被追问时防御性重复", domains=["work"])]
        context = prompts.build_context_blocks(cards, [], FakeLoop(), cards[0])

        # 用户档案必须在
        assert "被追问时防御性重复" in context
        assert "开会被追问进度" in context
        # 辩论人格绝不能出现
        assert "辩论对手" not in context
        assert prompts.FIXED_SYSTEM_PROMPT not in context

    def test_stable_system_includes_persona(self):
        stable = prompts.build_stable_system([FakeCard(1, "甲")])
        assert stable.startswith(prompts.FIXED_SYSTEM_PROMPT)
        assert "辩论对手" in stable

    def test_stable_system_is_persona_plus_context(self):
        cards = [FakeCard(1, "甲", domains=["work"])]
        assert prompts.build_stable_system(cards) == (
            prompts.FIXED_SYSTEM_PROMPT + "\n\n" + prompts.build_context_blocks(cards)
        )

    def test_review_uses_single_system_message(self):
        """两条 system 消息会让模型在「辩手」和「观察者」之间二选一。"""
        context = prompts.build_context_blocks([FakeCard(1, "甲")])
        messages = prompts.build_review_messages("辩题", "立场", "AI：x\n用户：y", context)

        system_messages = [m for m in messages if m.role == "system"]
        assert len(system_messages) == 1, "复盘只应有一条 system 消息"
        assert "辩论对手" not in system_messages[0].content
        assert "辩论观察者" in system_messages[0].content
        # 用户档案被并入同一条
        assert "甲" in system_messages[0].content


class TestDebateHistoryNotDuplicated:
    """history 从库里取的全量消息里**已经包含**用户刚发的那条，
    build_debate_messages 还会追加 latest。不剔除就会连续发两遍同一句话，
    模型会以为用户在强调，回答跑偏。
    """

    def test_stream_reply_drops_duplicate_latest(self, monkeypatch):
        import asyncio

        from app.services import debate as debate_service

        captured: dict = {}

        def fake_stream(task, messages, **kwargs):
            captured["messages"] = messages

            async def _empty():
                if False:
                    yield ""

            return _empty()

        import app.ai.router as router_module

        monkeypatch.setattr(router_module, "stream", fake_stream)

        class M:
            def __init__(self, role, content, seq=0):
                self.role, self.content, self.seq, self.round = role, content, seq, 0

        history = [
            M("ai", "我站对立面", 1),
            M("user", "我觉得当场反驳是对的", 2),
        ]
        room = type("R", (), {"topic": "t", "stance": "s"})()

        asyncio.run(_drain(debate_service.stream_reply(
            room, debate_service.DebateContext(), history, "我觉得当场反驳是对的"
        )))

        contents = [m.content for m in captured["messages"]]
        assert contents.count("我觉得当场反驳是对的") == 1, (
            f"用户发言被重复发送了：{contents}"
        )


async def _drain(agen):
    async for _ in agen:
        pass
