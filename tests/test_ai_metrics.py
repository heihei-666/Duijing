"""对镜 · AI 调用观测（ai_call_log）

这个文件守住「模型调用到底花了多少、快不快、缓存有没有生效」这条路。

背景：`AIUsage`（prompt/completion/cached tokens）在 provider 层一直被采集，
但在 2026-10-03 之前**没有任何读取方** —— 没有落库、没有聚合、没有日志。
于是这个项目主打的三个技术点全都无法自证：

    多模型路由 → 两家的延迟/失败率/成本各是多少？
    前缀缓存   → 命中率多少？省了多少钱？
    SSE 流式   → TTFT 多少？

面试时只能答「我用了 X」。这个文件确保以后能答「数据是 Y」。
"""

from __future__ import annotations

import asyncio

import pytest

from app.services import ai_metrics
from app.services.ai_metrics import estimate_cost, record_ai_call, snapshot
from tests.conftest import register


@pytest.fixture(autouse=True)
def _clean_buffer():
    """缓冲区与累计计数都是进程级的，用例之间必须隔离。"""
    ai_metrics.reset_for_tests()
    yield
    ai_metrics.reset_for_tests()


class _FakeSession:
    """只记录 add 了什么，用来测缓冲/落库逻辑，不碰数据库。"""

    def __init__(self, *, fail: bool = False) -> None:
        self.added: list = []
        self.fail = fail

    def add(self, obj) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        if self.fail:
            raise RuntimeError("模拟落库失败")


class TestCostEstimate:
    def test_cached_input_is_cheaper_than_uncached(self):
        """缓存命中比未命中便宜 —— 这正是「前缀缓存省了钱」的算术基础。"""
        cached = estimate_cost(
            "deepseek", prompt_tokens=1_000_000, cached_tokens=1_000_000, completion_tokens=0
        )
        uncached = estimate_cost(
            "deepseek", prompt_tokens=1_000_000, cached_tokens=0, completion_tokens=0
        )
        assert cached < uncached
        # 方案 5.1：命中 0.02 元/M，未命中 1 元/M
        assert cached == pytest.approx(0.02, abs=1e-9)
        assert uncached == pytest.approx(1.0, abs=1e-9)

    def test_output_price_differs_by_provider(self):
        """MiMo 输出价是 DeepSeek 的一半（方案 5.1）—— 这就是路由的省钱依据。"""
        ds = estimate_cost("deepseek", prompt_tokens=0, cached_tokens=0, completion_tokens=1_000_000)
        mimo = estimate_cost("mimo", prompt_tokens=0, cached_tokens=0, completion_tokens=1_000_000)
        assert ds == pytest.approx(4.0, abs=1e-9)
        assert mimo == pytest.approx(2.0, abs=1e-9)

    def test_unknown_provider_costs_nothing_instead_of_crashing(self):
        assert estimate_cost("someone-else", prompt_tokens=100, cached_tokens=0, completion_tokens=100) == 0.0

    def test_cached_tokens_cannot_exceed_prompt(self):
        """provider 偶尔会给出比 prompt 还大的 cached 值，不能让未命中变成负数。"""
        cost = estimate_cost(
            "deepseek", prompt_tokens=100, cached_tokens=999, completion_tokens=0
        )
        assert cost >= 0


class TestBufferAndFlush:
    def test_record_and_snapshot(self):
        before = snapshot()
        record_ai_call(
            task="debate_reply",
            provider="deepseek",
            model="deepseek-flash",
            prompt_tokens=1000,
            completion_tokens=200,
            cached_tokens=800,
        )
        after = snapshot()

        assert after["calls"] == before["calls"] + 1
        assert after["prompt_tokens"] == before["prompt_tokens"] + 1000
        assert after["cached_tokens"] == before["cached_tokens"] + 800
        assert after["cost_yuan"] > before["cost_yuan"]

    def test_cache_hit_rate_is_exposed(self):
        """这是「我用了前缀缓存」→「命中率 X%」的那一步。"""
        ai_metrics.drain()
        record_ai_call(
            task="debate_reply", provider="deepseek", prompt_tokens=1000, cached_tokens=600
        )
        live = snapshot()
        assert live["cache_hit_rate"] == pytest.approx(0.6, abs=1e-6)

    def test_errors_are_counted(self):
        record_ai_call(task="review_card", provider="mimo", status="error", error="boom")
        assert snapshot()["errors"] >= 1

    def test_flush_writes_rows_and_clears_buffer(self):
        record_ai_call(task="topic_generation", provider="mimo", prompt_tokens=50)
        assert ai_metrics.pending_count() == 1

        session = _FakeSession()
        written = asyncio.run(ai_metrics.flush_to_db(session))

        assert written == 1
        assert ai_metrics.pending_count() == 0
        row = session.added[0]
        assert row.task == "topic_generation"
        assert row.provider == "mimo"

    def test_flush_failure_puts_records_back(self):
        """一次写失败不该让观测数据永久消失。"""
        record_ai_call(task="event_scan", provider="mimo", prompt_tokens=10)

        with pytest.raises(RuntimeError):
            asyncio.run(ai_metrics.flush_to_db(_FakeSession(fail=True)))

        assert ai_metrics.pending_count() == 1, "落库失败必须把记录放回缓冲"

    def test_record_never_raises(self):
        """观测不能反过来搞挂业务：即使字段畸形也不能抛。"""
        record_ai_call(task="x", provider="y", prompt_tokens="not-a-number")  # type: ignore[arg-type]


class TestRealCallsAreRecorded:
    def test_debate_creation_records_calls_with_the_caller(self, client, unique_name):
        """跑一次真实流程，确认调用被记下来、且带上了 user_id。"""
        actor = register(client, unique_name("aimetric"))
        me = actor.get("/api/auth/me").json()["user"]["id"]

        resp = actor.post(
            "/api/debates", json={"topic": "该不该当场反驳", "stance": "该"}
        )
        assert resp.status_code in (200, 201), resp.text

        entries = ai_metrics.drain()
        assert entries, "建辩论会调模型生成开场白，应当有记录"
        assert all(e["user_id"] == me for e in entries), "记录必须归属于发起请求的人"
        assert any(e["task"] == "debate_reply" for e in entries)
        assert all(e["provider"] for e in entries)

    def test_prompt_version_is_recorded(self, client, unique_name):
        """有了版本号，才能回答「这条观察是哪个 prompt 版本产生的」。"""
        actor = register(client, unique_name("aiver"))
        actor.post("/api/debates", json={"topic": "该不该坚持", "stance": "该"})

        entries = ai_metrics.drain()
        assert entries
        assert all(e["prompt_version"] for e in entries), "prompt 版本必须随调用落库"

    def test_rows_reach_the_database(self, client, unique_name):
        """端到端：调用 → 缓冲 → 落库 → 查得到。"""
        from sqlalchemy import func, select

        from app.db import session_scope
        from app.models import AICallLog

        actor = register(client, unique_name("aidb"))
        actor.post("/api/debates", json={"topic": "该不该退让", "stance": "不该"})

        async def _flush_and_count() -> tuple[int, int]:
            async with session_scope() as session:
                written = await ai_metrics.flush_to_db(session)
            async with session_scope() as session:
                total = await session.scalar(select(func.count()).select_from(AICallLog))
            return written, int(total or 0)

        written, total = asyncio.run(_flush_and_count())
        assert written >= 1
        assert total >= written


class TestAdminStatsEndpoint:
    @staticmethod
    def _admin_actor(client):
        """引导管理员是第一个注册的用户，自动具备 is_admin。"""
        from tests.conftest import Actor

        resp = client.post(
            "/api/auth/login",
            json={"username": "bootstrap_admin", "password": "BootstrapPass123"},
        )
        assert resp.status_code == 200, resp.text
        client.cookies.clear()
        return Actor(client, "bootstrap_admin", resp.json()["token"])

    def test_requires_login(self, client):
        client.cookies.clear()
        assert client.get("/api/admin/ai-stats").status_code == 401

    def test_non_admin_is_forbidden(self, client, unique_name):
        actor = register(client, unique_name("notadmin"))
        assert actor.get("/api/admin/ai-stats").status_code == 403

    def test_admin_gets_a_usable_report(self, client, unique_name):
        admin = self._admin_actor(client)
        # 先制造一些调用
        actor = register(client, unique_name("aistats"))
        actor.post("/api/debates", json={"topic": "该不该解释", "stance": "该"})
        asyncio.run(self._flush())

        resp = admin.get("/api/admin/ai-stats?days=1&recent=5")
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert body["window_days"] == 1
        for key in (
            "totals",
            "by_provider",
            "by_task",
            "recent_calls",
            "live",
            "prices",
        ):
            assert key in body, f"报告里缺 {key}"

        # 价格表必须随响应返回，成本数字才可复核
        assert "deepseek" in body["prices"]
        assert body["prices_unit"] == "元 / 百万 token"

        assert body["totals"]["calls"] >= 1
        assert body["totals"]["cost_yuan"] >= 0
        # 缓存命中率可能为 None（没数据时），但不能是缺失字段
        assert "cache_hit_rate" in body["totals"]

    def test_recent_calls_expose_ttft_for_streaming(self, client, unique_name):
        """TTFT 是流式应用的标准指标，明细里必须看得到。"""
        admin = self._admin_actor(client)
        actor = register(client, unique_name("aittft"))
        actor.post("/api/debates", json={"topic": "该不该坚持", "stance": "该"})
        asyncio.run(self._flush())

        body = admin.get("/api/admin/ai-stats?days=1&recent=20").json()
        assert body["recent_calls"], "应该有明细"
        sample = body["recent_calls"][0]
        assert "ttft_ms" in sample
        assert "prompt_version" in sample

    @staticmethod
    async def _flush():
        from app.db import session_scope

        async with session_scope() as session:
            await ai_metrics.flush_to_db(session)
