"""对镜 · AI 延迟队列（真队列）

方案 5.4：事件卡不实时扫描，进队列，夜里批量处理。

**这张表此前是「假队列」**：任务能进队，但没有消费者 ——
周扫描不看 `task_type`/`payload_json`，自己重新查一遍要处理什么，
然后把所有 pending 行**无条件标成 done**；`processing`/`failed`/`error`
从未被写过，行也永不清理。

所以真实执行是「定时任务全表扫一遍」，队列只是流水账。
面试里问「失败了怎么办 / 幂等吗 / 积压怎么发现」，一个都答不上来。

这个文件锁住真队列的五条性质：
**幂等、可重试且有上限、不可重试的失败不浪费重试、陈旧行可回收、积压可见**。

注意：测试共用一个数据库，队列里会留着前面用例的任务，
所以所有断言都**按 user_id 过滤**到本用例自己造的那条，不能用「第一条」。
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.models import AIQueue, QueueStatus
from app.services import ai_queue as queue_service
from app.utils import now_utc
from tests.conftest import register


def _new_session():
    from app.db import session_scope

    return session_scope()


def _run(coro):
    return asyncio.run(coro)


def _user_id(actor) -> int:
    resp = actor.get("/api/auth/me")
    assert resp.status_code == 200, resp.text
    return resp.json()["user"]["id"]


def _enqueue_minimal_card(actor) -> tuple[int, int]:
    """走极简模式建一张事件卡 —— 这正是入队的真实入口。返回 (user_id, card_id)。"""
    resp = actor.post("/api/event-cards", json={"content": "今天开会又被追问进度，我卡住了"})
    assert resp.status_code in (200, 201), resp.text
    return _user_id(actor), resp.json()["card"]["id"]


def _insert_task(
    user_id: int,
    *,
    task_type: str = "analyze_event_card",
    payload: dict | None = None,
    status: str = QueueStatus.PENDING.value,
    started_at=None,
) -> int:
    """直接插一条队列任务，用于构造「历史遗留/异常状态」的场景。"""

    async def _insert() -> int:
        async with _new_session() as session:
            task = AIQueue(
                user_id=user_id,
                task_type=task_type,
                payload_json=payload if payload is not None else {"card_id": 1},
                status=status,
                started_at=started_at,
            )
            session.add(task)
            await session.flush()
            return task.id

    return _run(_insert())


def _task(task_id: int) -> AIQueue:
    async def _get():
        async with _new_session() as session:
            return await session.get(AIQueue, task_id)

    return _run(_get())


def _process(limit: int = 50) -> dict:
    async def _run_process():
        async with _new_session() as session:
            return await queue_service.process_pending(session, limit=limit)

    return _run(_run_process())


class TestEnqueueValidatesTaskType:
    def test_unknown_task_type_is_rejected_at_enqueue(self, client):
        """没注册处理器的类型进了队也只能在夜里失败，不如入队时就报出来。"""

        async def _run_enqueue():
            from app.services import event_cards as ec

            async with _new_session() as session:
                await ec.enqueue(session, user_id=1, task_type="not-a-real-task", payload={})

        with pytest.raises(ValueError, match="未注册的任务类型"):
            _run(_run_enqueue())


class TestProcessPending:
    def test_pending_task_is_actually_executed(self, client, unique_name):
        """核心回归：任务必须被**执行**，而不是被标成 done 了事。"""
        actor = register(client, unique_name("q1"))
        user_id, card_id = _enqueue_minimal_card(actor)

        # 入队后应当有一条 pending
        assert _tasks_of(user_id)[0].status == QueueStatus.PENDING.value

        stats = _process()
        assert stats["claimed"] >= 1 and stats["done"] >= 1

        tasks = _tasks_of(user_id)
        assert len(tasks) == 1
        task = tasks[0]
        assert task.status == QueueStatus.DONE.value
        assert task.processed_at is not None

        # 真的动了卡片，而不只是改了队列状态
        cards = actor.get("/api/event-cards").json()["cards"]
        card = next(c for c in cards if c["id"] == card_id)
        assert card["analyzed"] is True

    def test_second_run_is_idempotent(self, client, unique_name):
        """再跑一次不该重复分析；任务已 done，不会回到 pending。"""
        actor = register(client, unique_name("q2"))
        user_id, _ = _enqueue_minimal_card(actor)

        _process()
        _process()
        assert _tasks_of(user_id)[0].status == QueueStatus.DONE.value

    def test_already_analyzed_card_is_skipped_not_failed(self, client, unique_name):
        """用户先点了「立即分析」，队列里的同一条任务稍后仍会跑到。

        此时卡片已经 analyzed —— 这必须算**成功跳过**，不是错误。
        """
        actor = register(client, unique_name("q3"))
        user_id, _ = _enqueue_minimal_card(actor)

        assert actor.post("/api/event-cards/analyze").status_code == 200

        stats = _process()
        assert stats["failed"] == 0
        assert _tasks_of(user_id)[0].status == QueueStatus.DONE.value

    def test_missing_card_counts_as_done(self, client, unique_name):
        """卡片被删了：幂等地算成功，不是错误。"""
        actor = register(client, unique_name("q_missing"))
        user_id = _user_id(actor)
        task_id = _insert_task(user_id, payload={"card_id": 987654321})

        _process()
        assert _task(task_id).status == QueueStatus.DONE.value


def _tasks_of(user_id: int) -> list[AIQueue]:
    async def _get():
        async with _new_session() as session:
            rows = await session.execute(
                select(AIQueue)
                .where(AIQueue.user_id == user_id)
                .order_by(AIQueue.id.asc())
            )
            return list(rows.scalars().all())

    return _run(_get())


class TestRetryAndFailure:
    def test_transient_failure_goes_back_to_pending(self, client, unique_name, monkeypatch):
        from app.services import event_cards as ec

        actor = register(client, unique_name("q4"))
        user_id, _ = _enqueue_minimal_card(actor)

        async def boom(*args, **kwargs):
            raise RuntimeError("模拟模型不可用")

        monkeypatch.setattr(ec, "analyze_card", boom)

        stats = _process()
        assert stats["retried"] >= 1

        task = _tasks_of(user_id)[0]
        assert task.status == QueueStatus.PENDING.value, "没到上限应放回队列重试"
        assert task.attempts == 1
        assert "模拟模型不可用" in (task.error or "")

    def test_gives_up_after_max_attempts(self, client, unique_name, monkeypatch):
        """一条永远失败的任务不该无限占着队列，也不该静默消失。"""
        from app.services import event_cards as ec

        actor = register(client, unique_name("q5"))
        user_id, _ = _enqueue_minimal_card(actor)

        async def boom(*args, **kwargs):
            raise RuntimeError("永久损坏")

        monkeypatch.setattr(ec, "analyze_card", boom)

        for _ in range(queue_service.MAX_ATTEMPTS):
            _process()

        task = _tasks_of(user_id)[0]
        assert task.status == QueueStatus.FAILED.value
        assert task.attempts == queue_service.MAX_ATTEMPTS
        assert task.processed_at is not None
        assert task.error

        # 失败之后不再被认领
        assert _process()["claimed"] == 0

    def test_permanent_failure_does_not_waste_retries(self, client, unique_name):
        """载荷坏了重试多少次都一样 —— 应当立刻失败，而不是拖三次。"""
        actor = register(client, unique_name("q6"))
        user_id = _user_id(actor)
        task_id = _insert_task(user_id, payload={"card_id": "not-an-int"})

        stats = _process()
        assert stats["failed"] >= 1
        assert stats["retried"] == 0, "不可重试的失败不该进重试队列"

        task = _task(task_id)
        assert task.status == QueueStatus.FAILED.value
        assert "card_id" in (task.error or "")

    def test_unknown_task_type_row_is_failed_with_reason(self, client, unique_name):
        """历史上可能已经存在未注册类型的行（比如改名之后）。"""
        actor = register(client, unique_name("q_legacy"))
        user_id = _user_id(actor)
        task_id = _insert_task(user_id, task_type="legacy_task", payload={})

        stats = _process()
        assert stats["unknown_task_type"] >= 1

        task = _task(task_id)
        assert task.status == QueueStatus.FAILED.value
        assert "未知任务类型" in (task.error or "")


class TestStaleRecovery:
    def test_stuck_processing_row_is_recovered(self, client, unique_name):
        """进程在任务执行到一半时挂了 —— 没有这一步，那行会永远是 processing。

        而且**没有任何迹象**：既不会被重试，也不出现在 pending 计数里。
        """
        actor = register(client, unique_name("q7"))
        user_id = _user_id(actor)
        task_id = _insert_task(
            user_id,
            payload={"card_id": 999999999},  # 不存在的卡：回收后应当被幂等地判成功
            status=QueueStatus.PROCESSING.value,
            started_at=now_utc()
            - timedelta(minutes=queue_service.STALE_PROCESSING_MINUTES + 5),
        )

        stats = _process()
        assert stats["recovered"] >= 1
        assert _task(task_id).status == QueueStatus.DONE.value

    def test_fresh_processing_row_is_left_alone(self, client, unique_name):
        """刚开始执行的行不能被误回收，否则会和正在跑的任务打架。"""
        actor = register(client, unique_name("q8"))
        user_id = _user_id(actor)
        task_id = _insert_task(
            user_id, status=QueueStatus.PROCESSING.value, started_at=now_utc()
        )

        assert _process()["recovered"] == 0
        assert _task(task_id).status == QueueStatus.PROCESSING.value


class TestBacklogIsVisible:
    def test_backlog_reports_depth_and_oldest_age(self, client, unique_name):
        actor = register(client, unique_name("q9"))
        _enqueue_minimal_card(actor)

        async def _snapshot():
            async with _new_session() as session:
                return await queue_service.backlog(session)

        snap = _run(_snapshot())
        assert snap["pending"] >= 1
        assert snap["max_attempts"] == queue_service.MAX_ATTEMPTS
        assert snap["stale_processing_minutes"] == queue_service.STALE_PROCESSING_MINUTES
        # 积压最直接的信号：最老的一条待办等了多久
        assert snap["oldest_pending_age_seconds"] is not None

    def test_admin_stats_include_queue_health(self, client, unique_name):
        from tests.test_ai_metrics import TestAdminStatsEndpoint

        admin = TestAdminStatsEndpoint._admin_actor(client)
        body = admin.get("/api/admin/ai-stats").json()
        assert "queue" in body, "没有队列健康度，「批处理积压了没有」就只能靠人肉发现"
        for key in ("pending", "processing", "failed", "oldest_pending_age_seconds"):
            assert key in body["queue"]


class TestWeeklyScanNoLongerFakesCompletion:
    def test_weekly_scan_does_not_touch_the_queue(self, client):
        """回归护栏：那个「把所有 pending 无条件标成 done」的假收尾不能再回来。"""
        import inspect

        from app.services import event_cards as ec

        source = inspect.getsource(ec.run_weekly_scan)
        assert "AIQueue" not in source, (
            "run_weekly_scan 不该再直接操作队列 —— 消费者是 app/services/ai_queue.py"
        )
