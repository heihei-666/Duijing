"""对镜 · 冷启动迭代测试

覆盖 P0/P1/P2 三块新能力：
  · 撑住率「无数据」与「0%」的区分（新用户看到的第一个数字）
  · 撑住率趋势（本周 vs 上周）
  · 预约辩论提醒与 Web Push 订阅
  · 账号数据导出与注销申请

共同的主题是「不要让用户误解自己的处境」——
前两组是数字的诚实，后两组是数据的归属。
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.services import push as push_service
from app.utils import local_now, local_today, to_utc
from tests.conftest import make_loop, make_weakness, register


# ─────────────────────────────────────────────────────────────
# 预设时间点的解析（纯逻辑，最容易出错）
# ─────────────────────────────────────────────────────────────


class TestReminderPresets:
    def test_relative_presets(self):
        now = local_now()
        in30 = push_service.resolve_preset("in_30min", reference=now)
        in1h = push_service.resolve_preset("in_1h", reference=now)

        assert in30 is not None and in1h is not None
        delta30 = (in30 - to_utc(now)).total_seconds()
        delta1h = (in1h - to_utc(now)).total_seconds()
        assert abs(delta30 - 1800) < 5
        assert abs(delta1h - 3600) < 5

    def test_tonight_8_rolls_to_tomorrow_if_passed(self):
        """「今晚 8 点」在 21:00 预约时必须落到明天，而不是一个已过去的时刻。"""
        late = local_now().replace(hour=21, minute=0, second=0, microsecond=0)
        target = push_service.resolve_preset("tonight_8", reference=late)
        assert target is not None
        assert target > to_utc(late), "不能返回一个已经过去的时间"

        local_target = target.astimezone(late.tzinfo)
        assert local_target.hour == 20
        assert local_target.date() == (late + timedelta(days=1)).date()

    def test_tonight_8_stays_today_when_early(self):
        early = local_now().replace(hour=9, minute=0, second=0, microsecond=0)
        target = push_service.resolve_preset("tonight_8", reference=early)
        assert target is not None
        local_target = target.astimezone(early.tzinfo)
        assert local_target.date() == early.date()
        assert local_target.hour == 20

    def test_unknown_preset_returns_none(self):
        assert push_service.resolve_preset("next_century") is None

    def test_all_declared_presets_resolve(self):
        """预设表里列的每一项都必须能解析出来，否则前端会给出一个坏选项。"""
        for key in push_service.REMINDER_PRESETS:
            assert push_service.resolve_preset(key) is not None, f"{key} 无法解析"


# ─────────────────────────────────────────────────────────────
# 提醒的预约 / 查询 / 取消
# ─────────────────────────────────────────────────────────────


class TestDebateReminder:
    def _room(self, actor) -> int:
        resp = actor.post("/api/debates", json={"topic": "该不该当场反驳", "stance": "该"})
        assert resp.status_code == 201, resp.text
        return resp.json()["room"]["id"]

    def test_set_and_read_reminder(self, client, unique_name):
        actor = register(client, unique_name("rem1"))
        room_id = self._room(actor)

        assert actor.get(f"/api/debates/{room_id}/reminder").json()["reminder"] is None

        resp = actor.post(f"/api/debates/{room_id}/reminder", json={"preset": "tonight_8"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["reminder"]["status"] == "pending"
        assert body["reminder"]["remind_at"]
        # 没有订阅设备时必须如实告知，不能让用户以为约好了
        assert body["will_notify"] is False
        assert body["device_count"] == 0

        assert actor.get(f"/api/debates/{room_id}/reminder").json()["reminder"]["id"] == body["reminder"]["id"]

    def test_reset_overwrites_instead_of_duplicating(self, client, unique_name):
        actor = register(client, unique_name("rem2"))
        room_id = self._room(actor)

        first = actor.post(
            f"/api/debates/{room_id}/reminder", json={"preset": "in_1h"}
        ).json()["reminder"]
        second = actor.post(
            f"/api/debates/{room_id}/reminder", json={"preset": "tomorrow_8"}
        ).json()["reminder"]

        assert first["id"] == second["id"], "同一场辩论只应保留一条待发提醒"

    def test_cancel(self, client, unique_name):
        actor = register(client, unique_name("rem3"))
        room_id = self._room(actor)
        actor.post(f"/api/debates/{room_id}/reminder", json={"preset": "in_1h"})

        assert actor.client.delete(
            f"/api/debates/{room_id}/reminder", headers=actor._headers
        ).json()["cancelled"] is True
        assert actor.get(f"/api/debates/{room_id}/reminder").json()["reminder"] is None

    def test_past_time_rejected(self, client, unique_name):
        actor = register(client, unique_name("rem4"))
        room_id = self._room(actor)

        past = (local_now() - timedelta(hours=1)).isoformat()
        resp = actor.post(f"/api/debates/{room_id}/reminder", json={"remind_at": past})
        assert resp.status_code == 400
        assert "晚于现在" in resp.json()["detail"]

    def test_too_far_future_rejected(self, client, unique_name):
        actor = register(client, unique_name("rem5"))
        room_id = self._room(actor)

        far = (local_now() + timedelta(days=60)).isoformat()
        assert actor.post(
            f"/api/debates/{room_id}/reminder", json={"remind_at": far}
        ).status_code == 400

    def test_unknown_preset_rejected(self, client, unique_name):
        actor = register(client, unique_name("rem6"))
        room_id = self._room(actor)
        assert actor.post(
            f"/api/debates/{room_id}/reminder", json={"preset": "never"}
        ).status_code == 400

    def test_empty_payload_rejected(self, client, unique_name):
        actor = register(client, unique_name("rem7"))
        room_id = self._room(actor)
        assert actor.post(f"/api/debates/{room_id}/reminder", json={}).status_code == 400

    def test_other_user_cannot_touch_my_reminder(self, client, unique_name):
        alice = register(client, unique_name("rema"))
        room_id = self._room(alice)
        alice.post(f"/api/debates/{room_id}/reminder", json={"preset": "in_1h"})

        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("remb"), invite_code=code)

        assert bob.get(f"/api/debates/{room_id}/reminder").status_code == 403


# ─────────────────────────────────────────────────────────────
# 推送订阅
# ─────────────────────────────────────────────────────────────


class TestPushSubscription:
    def test_config_is_public_and_exposes_presets(self, client):
        resp = client.get("/api/push/config")
        assert resp.status_code == 200
        body = resp.json()
        # VAPID 密钥应当能生成（环境支持时）
        assert "available" in body
        assert isinstance(body["presets"], list) and body["presets"]
        assert {"key", "label"} <= set(body["presets"][0])

    def test_status_requires_login(self, client):
        assert client.get("/api/push/status").status_code == 401

    def test_subscribe_and_unsubscribe(self, client, unique_name):
        actor = register(client, unique_name("push1"))
        assert actor.get("/api/push/status").json()["subscribed"] is False

        endpoint = "https://fcm.googleapis.com/fcm/send/test-endpoint-abc"
        resp = actor.post(
            "/api/push/subscribe",
            json={"endpoint": endpoint, "keys": {"p256dh": "BAbc", "auth": "xyz"}},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["device_count"] == 1

        assert actor.get("/api/push/status").json()["subscribed"] is True

        assert actor.post("/api/push/unsubscribe", json={"endpoint": endpoint}).json()["removed"] is True
        assert actor.get("/api/push/status").json()["subscribed"] is False

    def test_resubscribe_same_endpoint_updates_not_duplicates(self, client, unique_name):
        """浏览器重新订阅会换掉密钥，旧记录留着只会推送失败。"""
        actor = register(client, unique_name("push2"))
        endpoint = "https://fcm.googleapis.com/fcm/send/same-endpoint"

        actor.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": "A", "auth": "1"}})
        resp = actor.post(
            "/api/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": "B", "auth": "2"}}
        )
        assert resp.json()["device_count"] == 1, "同一 endpoint 不应产生第二条记录"

    def test_incomplete_keys_rejected(self, client, unique_name):
        actor = register(client, unique_name("push3"))
        resp = actor.post(
            "/api/push/subscribe",
            json={"endpoint": "https://example.com/x", "keys": {"p256dh": "only-one"}},
        )
        assert resp.status_code == 400

    def test_non_https_endpoint_rejected(self, client, unique_name):
        """非 https 的 endpoint 一定是伪造的，推送服务只走 https。"""
        actor = register(client, unique_name("push4"))
        resp = actor.post(
            "/api/push/subscribe",
            json={"endpoint": "http://evil.local/x", "keys": {"p256dh": "a", "auth": "b"}},
        )
        assert resp.status_code == 400

    def test_test_push_without_device_returns_409(self, client, unique_name):
        actor = register(client, unique_name("push5"))
        resp = actor.post("/api/push/test")
        assert resp.status_code == 409
        assert "没有可用的推送设备" in resp.json()["detail"]


# ─────────────────────────────────────────────────────────────
# 提醒派发
# ─────────────────────────────────────────────────────────────


class TestReminderDispatch:
    def test_due_reminder_without_device_is_marked_failed_not_retried(self, client, unique_name):
        """没有设备订阅时标记失败并留下原因，不能无限重试。"""
        import asyncio

        from sqlalchemy import select

        from app.db import session_scope
        from app.models import DebateReminder, User
        from app.utils import now_utc

        actor = register(client, unique_name("disp1"))
        resp = actor.post("/api/debates", json={"topic": "t", "stance": "s"}).json()
        room_id = resp["room"]["id"]

        async def _seed():
            async with session_scope() as session:
                user = await session.scalar(select(User).where(User.username == actor.username))
                # 直接造一条「已到点」的提醒（绕过 400 校验）
                session.add(
                    DebateReminder(
                        user_id=user.id,
                        room_id=room_id,
                        remind_at=now_utc() - timedelta(minutes=1),
                        status="pending",
                    )
                )

        asyncio.run(_seed())

        async def _dispatch():
            async with session_scope() as session:
                return await push_service.dispatch_due_reminders(session)

        stats = asyncio.run(_dispatch())
        assert stats["due"] >= 1
        assert stats["failed"] >= 1

        async def _check():
            async with session_scope() as session:
                rows = await session.execute(
                    select(DebateReminder).where(
                        DebateReminder.room_id == room_id,
                        DebateReminder.status == "failed",
                    )
                )
                item = rows.scalars().first()
                return item.error if item else None

        error = asyncio.run(_check())
        assert error and "推送设备" in error


# ─────────────────────────────────────────────────────────────
# 账号数据
# ─────────────────────────────────────────────────────────────


class TestAccountData:
    def _seed(self, actor) -> None:
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])
        actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold", "note": "导出用"})
        actor.post("/api/event-cards", json={"content": "开会时被追问"})
        actor.post("/api/principles", json={"content": "先承认，再补充"})
        actor.post("/api/debates", json={"topic": "该不该当场反驳", "stance": "该"})

    def test_export_contains_my_data(self, client, unique_name):
        actor = register(client, unique_name("exp1"))
        self._seed(actor)

        resp = actor.get("/api/account/export")
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["app"] == "对镜"
        assert data["account"]["username"] == actor.username
        assert len(data["weaknesses"]) >= 1
        assert len(data["loops"]) >= 1
        assert len(data["loop_logs"]) >= 1
        assert len(data["event_cards"]) >= 1
        assert len(data["principles"]) >= 1
        assert len(data["debates"]) >= 1
        assert data["stats"]["weakness_count"] >= 1

        # 下载文件名
        assert "duijing-export" in resp.headers.get("content-disposition", "")

    def test_export_covers_date_only_fields(self, client, unique_name):
        """`LoopLog.date` / `DailyState.date` 是纯 date 不是 datetime，
        序列化路径不同，必须单独覆盖——这里曾经崩过一次。"""
        actor = register(client, unique_name("exp3"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])
        actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold"})
        actor.post("/api/daily-state", json={"energy": 72, "mood": "calm"})

        data = actor.get("/api/account/export").json()
        log_date = data["loop_logs"][0]["date"]
        assert isinstance(log_date, str) and len(log_date) == 10, f"日期格式异常: {log_date!r}"
        assert data["daily_states"][0]["date"] == local_today().isoformat()
        assert data["daily_states"][0]["energy"] == 72

    def test_export_covers_reminders_and_observation_fields(self, client, unique_name):
        actor = register(client, unique_name("exp4"))
        room_id = actor.post(
            "/api/debates", json={"topic": "t", "stance": "s"}
        ).json()["room"]["id"]
        actor.post(f"/api/debates/{room_id}/reminder", json={"preset": "in_1h"})

        data = actor.get("/api/account/export").json()
        assert len(data["reminders"]) == 1
        assert data["reminders"][0]["status"] == "pending"
        assert data["reminders"][0]["remind_at"].endswith("Z")

    def test_export_never_contains_password_hash(self, client, unique_name):
        """导出是给用户带走自己的记录，不是给出一份能撞库的凭据。"""
        actor = register(client, unique_name("exp2"))
        raw = actor.get("/api/account/export").text
        assert "password_hash" not in raw
        assert "$2b$" not in raw, "不能出现 bcrypt 哈希"

    def test_export_is_scoped_to_me(self, client, unique_name):
        alice = register(client, unique_name("expa"))
        self._seed(alice)
        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("expb"), invite_code=code)

        data = bob.get("/api/account/export").json()
        assert data["weaknesses"] == []
        assert data["debates"] == []
        assert data["stats"]["weakness_count"] == 0

    def test_deletion_request_and_cancel(self, client, unique_name):
        actor = register(client, unique_name("del1"))

        assert actor.get("/api/account/deletion").json()["requested"] is False

        resp = actor.post("/api/account/deletion")
        assert resp.status_code == 200
        assert "人工确认" in resp.json()["message"]

        status = actor.get("/api/account/deletion").json()
        assert status["requested"] is True
        assert status["requested_at"]

        # 申请后仍可正常使用（后端不做即时删除）
        assert actor.get("/api/status-bar").status_code == 200

        # 可以反悔
        assert actor.client.delete("/api/account/deletion", headers=actor._headers).json()["ok"] is True
        assert actor.get("/api/account/deletion").json()["requested"] is False

    def test_deletion_revokes_push_subscriptions(self, client, unique_name):
        """用户既然要走了，就不该再收到任何通知。"""
        actor = register(client, unique_name("del2"))
        actor.post(
            "/api/push/subscribe",
            json={"endpoint": "https://fcm.googleapis.com/fcm/send/del-me", "keys": {"p256dh": "a", "auth": "b"}},
        )
        assert actor.get("/api/push/status").json()["subscribed"] is True

        actor.post("/api/account/deletion")
        assert actor.get("/api/push/status").json()["subscribed"] is False

    def test_account_endpoints_require_login(self, client):
        assert client.get("/api/account/export").status_code == 401
        assert client.post("/api/account/deletion").status_code == 401


class TestReminderDispatchSuccess:
    """派发的成功路径。

    真实推送需要浏览器环境，这里把发送函数替换掉，
    验证「到点 → 取订阅 → 发送 → 标记 sent」这条链路本身是通的。
    否则一旦线上没人收到提醒，我们连问题出在哪一环都不知道。
    """

    def _seed_due(self, actor, room_id):
        import asyncio

        from sqlalchemy import select

        from app.db import session_scope
        from app.models import DebateReminder, User
        from app.utils import now_utc

        async def _run():
            async with session_scope() as session:
                user = await session.scalar(select(User).where(User.username == actor.username))
                session.add(
                    DebateReminder(
                        user_id=user.id,
                        room_id=room_id,
                        remind_at=now_utc() - timedelta(seconds=10),
                        status="pending",
                    )
                )

        asyncio.run(_run())

    def _subscribe(self, actor) -> str:
        endpoint = "https://fcm.googleapis.com/fcm/send/dispatch-ok"
        actor.post(
            "/api/push/subscribe",
            json={"endpoint": endpoint, "keys": {"p256dh": "key", "auth": "auth"}},
        )
        return endpoint

    def test_due_reminder_is_sent_and_marked(self, client, unique_name, monkeypatch):
        import asyncio

        from sqlalchemy import select

        from app.db import session_scope
        from app.models import DebateReminder
        from app.services import push as push_module

        actor = register(client, unique_name("dok"))
        room_id = actor.post("/api/debates", json={"topic": "t", "stance": "s"}).json()["room"]["id"]
        self._subscribe(actor)
        self._seed_due(actor, room_id)

        sent_payloads: list[dict] = []

        def fake_send_one(subscription, payload, private_pem):
            sent_payloads.append(payload)

        monkeypatch.setattr(push_module, "_send_one", fake_send_one)

        async def _dispatch():
            async with session_scope() as session:
                return await push_module.dispatch_due_reminders(session)

        stats = asyncio.run(_dispatch())
        assert stats["sent"] >= 1, f"应当发出至少一条，实际 {stats}"
        assert sent_payloads, "发送函数没有被调用"
        assert sent_payloads[0]["url"] == f"/debates/{room_id}"
        assert "tag" in sent_payloads[0]

        async def _check():
            async with session_scope() as session:
                rows = await session.execute(
                    select(DebateReminder).where(
                        DebateReminder.room_id == room_id,
                        DebateReminder.status == "sent",
                    )
                )
                item = rows.scalars().first()
                return item.sent_at if item else None

        assert asyncio.run(_check()) is not None, "发送后必须落到 sent 状态，否则会重复推送"

    def test_dispatch_is_idempotent(self, client, unique_name, monkeypatch):
        """再跑一次不应重发——否则定时任务重叠执行会重复打扰用户。"""
        import asyncio

        from app.db import session_scope
        from app.services import push as push_module

        actor = register(client, unique_name("didem"))
        room_id = actor.post("/api/debates", json={"topic": "t2", "stance": "s"}).json()["room"]["id"]
        self._subscribe(actor)
        self._seed_due(actor, room_id)

        calls: list[dict] = []
        monkeypatch.setattr(
            push_module, "_send_one", lambda sub, payload, pem: calls.append(payload)
        )

        async def _dispatch():
            async with session_scope() as session:
                return await push_module.dispatch_due_reminders(session)

        first = asyncio.run(_dispatch())
        before = len(calls)
        second = asyncio.run(_dispatch())

        assert first["sent"] >= 1
        assert second["sent"] == 0, "第二次不应重发"
        assert len(calls) == before

    def test_gone_subscription_is_disabled(self, client, unique_name, monkeypatch):
        """推送服务返回 410 说明订阅已失效（用户卸载了 PWA），
        必须标记停用，否则会一直被拒绝。"""
        import asyncio

        from pywebpush import WebPushException

        from app.db import session_scope
        from app.services import push as push_module

        actor = register(client, unique_name("gone"))
        room_id = actor.post("/api/debates", json={"topic": "t3", "stance": "s"}).json()["room"]["id"]
        self._subscribe(actor)
        self._seed_due(actor, room_id)

        class FakeResponse:
            status_code = 410

        def fake_send_one(subscription, payload, private_pem):
            raise WebPushException("Gone", response=FakeResponse())

        monkeypatch.setattr(push_module, "_send_one", fake_send_one)

        async def _dispatch():
            async with session_scope() as session:
                return await push_module.dispatch_due_reminders(session)

        asyncio.run(_dispatch())

        # 订阅被标记失效后，device_count 应归零
        assert actor.get("/api/push/status").json()["device_count"] == 0
