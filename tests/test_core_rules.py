"""对镜 · 核心业务规则测试

这个文件的每一条用例，都对应方案文档第九章「关键约束」或第三章的
某条明确规则。它们的价值不在于覆盖率，而在于**锁死那些一旦写错
就会静默损害用户数据的行为**——比如撑住率算错、观察无限累积、
降级被自动执行。
"""

from __future__ import annotations

import pytest

from tests.conftest import make_loop, make_weakness, register


# ─────────────────────────────────────────────────────────────
# 认证与注册（邀请码）
# ─────────────────────────────────────────────────────────────


class TestAuth:
    def test_register_issues_invite_code_and_session(self, client, unique_name):
        actor = register(client, unique_name("first"))

        me = actor.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"]["username"] == actor.username

        invite = actor.get("/api/auth/invite")
        assert invite.status_code == 200
        data = invite.json()
        assert len(data["code"]) == 8
        assert data["link"].endswith(data["code"])

    def test_invite_code_rotation_invalidates_old_one(self, client, unique_name):
        actor = register(client, unique_name("rot"))
        old_code = actor.get("/api/auth/invite").json()["code"]

        new_code = actor.post("/api/auth/invite/rotate").json()["code"]
        assert new_code != old_code

        # 旧码立即失效
        response = client.post(
            "/api/auth/register",
            json={
                "username": unique_name("stale"),
                "password": "TestPass123",
                "invite_code": old_code,
            },
        )
        assert response.status_code == 400

    def test_second_user_requires_valid_invite_code(self, client, unique_name):
        owner = register(client, unique_name("owner"))
        code = owner.get("/api/auth/invite").json()["code"]

        # 不带邀请码 → 拒绝
        bad = client.post(
            "/api/auth/register",
            json={"username": unique_name("nope"), "password": "TestPass123"},
        )
        assert bad.status_code == 400
        assert "邀请码" in bad.json()["detail"]

        # 错误邀请码 → 拒绝
        bad2 = client.post(
            "/api/auth/register",
            json={
                "username": unique_name("bad"),
                "password": "TestPass123",
                "invite_code": "WRONGXXX",
            },
        )
        assert bad2.status_code == 400

        # 正确邀请码 → 通过
        good = client.post(
            "/api/auth/register",
            json={
                "username": unique_name("guest"),
                "password": "TestPass123",
                "invite_code": code,
            },
        )
        assert good.status_code == 201, good.text

        # 邀请计数
        assert owner.get("/api/auth/invite").json()["used_count"] == 1

    def test_weak_password_rejected(self, client, unique_name):
        response = client.post(
            "/api/auth/register",
            json={"username": unique_name("weak"), "password": "123"},
        )
        assert response.status_code == 400

    def test_login_with_wrong_password_fails(self, client, unique_name):
        name = unique_name("login")
        register(client, name)
        response = client.post(
            "/api/auth/login", json={"username": name, "password": "WrongPass123"}
        )
        assert response.status_code == 401

    def test_unauthenticated_access_blocked(self, client):
        assert client.get("/api/status-bar").status_code == 401
        assert client.get("/api/weaknesses").status_code == 401


# ─────────────────────────────────────────────────────────────
# 约束 7：所有经验变动必须写 loop_log
# ─────────────────────────────────────────────────────────────


class TestLoopLogIsSourceOfTruth:
    def test_logging_updates_hold_rate(self, client, unique_name):
        actor = register(client, unique_name("log"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        # 初始：零触发，撑住率 0
        detail = actor.get(f"/api/weaknesses/{weakness['id']}").json()
        assert detail["loops"][0]["hold_rate_30d"] == 0
        assert detail["loops"][0]["trigger_count_30d"] == 0

        # 4 次撑住 + 1 次破功 = 5 次触发，撑住率 80%
        for _ in range(4):
            response = actor.post(
                f"/api/loops/{loop['id']}/logs", json={"result": "hold", "note": "ok"}
            )
            assert response.status_code == 201, response.text

        response = actor.post(
            f"/api/loops/{loop['id']}/logs", json={"result": "break", "note": "没撑住"}
        )
        body = response.json()
        assert body["hold_rate_30d"] == 80
        assert body["trigger_count_30d"] == 5

    def test_not_triggered_excluded_from_denominator(self, client, unique_name):
        """未触发不进分母——否则撑住率会被稀释得毫无意义。"""
        actor = register(client, unique_name("notrig"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold"})
        actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold"})
        response = actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "not_triggered"})

        body = response.json()
        assert body["trigger_count_30d"] == 2  # 未触发不计
        assert body["hold_rate_30d"] == 100

    def test_break_moves_loop_to_needs_revision(self, client, unique_name):
        """方案 3.3：破功 → 回环进入待修订，并给替代动作。"""
        actor = register(client, unique_name("brk"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])
        assert loop["status"] == "active"

        response = actor.post(
            f"/api/loops/{loop['id']}/logs", json={"result": "break", "note": "又硬撑了"}
        ).json()

        assert response["loop_status"] == "needs_revision"
        assert response["needs_revision"] is True
        assert response["alternative_action"]  # AI（Mock）给了替代动作

    def test_future_date_rejected(self, client, unique_name):
        """不能用系统本地日期算「明天」。

        服务的「今天」按 Asia/Shanghai 判定，而容器时区是 UTC。
        当 UTC 已过 16:00 时，上海的日期已经比 UTC 早一天，
        用 date.today()+1 算出来的"明天"在上海其实还是"今天"，
        用例会误报。必须用服务自己的 local_today()。
        """
        from datetime import timedelta

        from app.utils import local_today

        actor = register(client, unique_name("future"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        tomorrow = (local_today() + timedelta(days=1)).isoformat()
        response = actor.post(
            f"/api/loops/{loop['id']}/logs", json={"result": "hold", "date": tomorrow}
        )
        assert response.status_code == 400

        # 今天则必须被接受
        today = local_today().isoformat()
        ok = actor.post(
            f"/api/loops/{loop['id']}/logs", json={"result": "hold", "date": today}
        )
        assert ok.status_code == 201


# ─────────────────────────────────────────────────────────────
# 约束 8：回环降级必须用户确认，绝不自动降级
# ─────────────────────────────────────────────────────────────


class TestNoAutoDowngrade:
    def test_suggests_downgrade_but_does_not_execute(self, client, unique_name):
        actor = register(client, unique_name("down"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        # 5 次撑住 → 撑住率 100%，触发 5 次，达到降级线
        last = None
        for _ in range(5):
            last = actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold"}).json()

        assert last["hold_rate_30d"] == 100
        assert last["trigger_count_30d"] == 5
        assert last.get("suggest_downgrade") is True
        assert "reason" in last

        # 关键：只是建议，状态没有任何变化
        detail = actor.get(f"/api/weaknesses/{weakness['id']}").json()
        assert detail["loops"][0]["status"] == "active"
        assert detail["weakness"]["status"] == "improving"
        assert detail["suggest_downgrade"] is True

    def test_weakness_archive_requires_explicit_call(self, client, unique_name):
        actor = register(client, unique_name("arch"))
        weakness = make_weakness(actor)

        response = actor.post(f"/api/weaknesses/{weakness['id']}/archive").json()
        assert response["weakness"]["status"] == "archived"
        assert response["weakness"]["delete_after"] is not None
        assert response["weakness"]["days_until_delete"] <= 60

    def test_patch_cannot_archive_directly(self, client, unique_name):
        """绕过归档接口直接 PATCH status=archived 必须被拒——
        否则 60 天倒计时就不会被设置，垃圾桶逻辑全乱。"""
        actor = register(client, unique_name("bypass"))
        weakness = make_weakness(actor)

        response = actor.patch(
            f"/api/weaknesses/{weakness['id']}", json={"status": "archived"}
        )
        assert response.status_code == 400


# ─────────────────────────────────────────────────────────────
# 归档与恢复（方案 3.8）
# ─────────────────────────────────────────────────────────────


class TestArchive:
    def test_restore_preserves_trigger_count(self, client, unique_name):
        actor = register(client, unique_name("restore"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        for _ in range(3):
            actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold"})

        before = actor.get(f"/api/weaknesses/{weakness['id']}").json()
        assert before["weakness"]["drill_count"] == 3

        actor.post(f"/api/weaknesses/{weakness['id']}/archive")
        restored = actor.post(f"/api/weaknesses/{weakness['id']}/restore").json()

        assert restored["weakness"]["status"] == "observing"
        assert restored["weakness"]["archived_at"] is None
        assert restored["weakness"]["drill_count"] == 3  # 计数保留

    def test_archive_list_shows_countdown(self, client, unique_name):
        actor = register(client, unique_name("bin"))
        weakness = make_weakness(actor)
        actor.post(f"/api/weaknesses/{weakness['id']}/archive")

        payload = actor.get("/api/archive").json()
        assert payload["rules"]["weakness_delete_days"] == 60
        assert payload["rules"]["observation_restorable"] is False
        assert len(payload["weaknesses"]) >= 1
        assert payload["weaknesses"][0]["expires_in_days"] <= 60


# ─────────────────────────────────────────────────────────────
# 约束 4：弱点数据默认私密
# ─────────────────────────────────────────────────────────────


class TestPrivacy:
    def test_other_user_cannot_read_my_weakness(self, client, unique_name):
        alice = register(client, unique_name("alice"))
        weakness = make_weakness(alice)

        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("bob"), invite_code=code)

        assert bob.get(f"/api/weaknesses/{weakness['id']}").status_code == 404
        assert bob.get("/api/weaknesses").json()["total"] == 0

    def test_other_user_cannot_read_my_loop(self, client, unique_name):
        alice = register(client, unique_name("alice2"))
        weakness = make_weakness(alice)
        loop = make_loop(alice, weakness["id"])

        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("bob2"), invite_code=code)

        assert bob.get(f"/api/loops/{loop['id']}/logs").status_code == 404
        assert bob.patch(f"/api/loops/{loop['id']}", json={"status": "paused"}).status_code == 404


# ─────────────────────────────────────────────────────────────
# 约束 5 & 9：观察限流与 24 小时倒计时
# ─────────────────────────────────────────────────────────────


class TestObservations:
    def test_accept_creates_weakness(self, client, unique_name):
        actor = register(client, unique_name("obs"))
        # 造一条辩论并结束，拿到观察
        debate = actor.post("/api/debates", json={"topic": "该不该当场反驳", "stance": "该"}).json()
        room_id = debate["room"]["id"]
        # 至少 2 轮发言，否则观察者没有足够依据、按设计不产出观察
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "我认为该，因为效率高"})
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "而且我上周试过一次"})
        review = actor.post(f"/api/debates/{room_id}/finish").json()["review"]

        # 约束 5：最多 1 优势 + 1 弱点 + 1 替代动作
        assert len(review["observations"]) <= 2
        assert review["alternative_action"] is not None

        pending = actor.get("/api/observations").json()["observations"]
        assert pending, "两轮发言后应当产出观察"

        obs = pending[0]
        # 约束 9：从首次看到算，列表返回时应已写入 first_seen_at
        assert obs["first_seen_at"] is not None
        assert obs["expires_at"] is not None

        accepted = actor.post(f"/api/observations/{obs['id']}/accept").json()
        assert accepted["created"]["kind"] in ("weakness", "advantage")

        # 不能重复处理
        assert actor.post(f"/api/observations/{obs['id']}/accept").status_code == 409

    def test_expiry_is_24h_from_first_seen(self, client, unique_name):
        from datetime import datetime

        actor = register(client, unique_name("ttl"))
        debate = actor.post("/api/debates", json={"topic": "该不该坚持己见", "stance": "该"}).json()
        room_id = debate["room"]["id"]
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "坚持己见更重要"})
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "我以前吃过亏"})
        actor.post(f"/api/debates/{room_id}/finish")

        pending = actor.get("/api/observations").json()["observations"]
        assert pending, "两轮发言后应当产出观察"

        obs = pending[0]
        first_seen = datetime.fromisoformat(obs["first_seen_at"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(obs["expires_at"].replace("Z", "+00:00"))
        delta = (expires - first_seen).total_seconds()

        assert abs(delta - 24 * 3600) < 5, f"应为 24 小时，实际 {delta}s"
        # 创建时间应早于或等于首次看到时间
        assert obs["created_at"] <= obs["first_seen_at"]

    def test_status_bar_shows_observation_and_starts_timer(self, client, unique_name):
        """首页展示 AI 观察候选时，24 小时倒计时就开始走。"""
        actor = register(client, unique_name("bar"))
        debate = actor.post("/api/debates", json={"topic": "该不该妥协", "stance": "不该"}).json()
        room_id = debate["room"]["id"]
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "我觉得不该妥协"})
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "上次妥协后我后悔了"})
        actor.post(f"/api/debates/{room_id}/finish")

        bar = actor.get("/api/status-bar").json()
        assert "observations" in bar
        assert len(bar["observations"]) == 1  # 方案 3.7：首页最多 1 条

        # 首页返回候选就等于「首次看到」，倒计时应已开始
        detail = actor.get("/api/observations").json()["observations"][0]
        assert detail["first_seen_at"] is not None
        assert detail["expires_at"] is not None


# ─────────────────────────────────────────────────────────────
# 优势库（方案 3.5）
# ─────────────────────────────────────────────────────────────


class TestAdvantages:
    def _make_advantage(self, actor) -> int:
        """通过一场辩论产出优势观察，再接受它。

        刻意不直接写库：跨事件循环直连 async engine 会让 aiosqlite
        挂在不同的 loop 上，是典型的 flaky 来源。
        """
        room_id = actor.post(
            "/api/debates", json={"topic": "该不该在会上直接反驳", "stance": "该"}
        ).json()["room"]["id"]
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "我认为该，效率高"})
        actor.post(f"/api/debates/{room_id}/messages", json={"content": "而且我举过例子"})
        actor.post(f"/api/debates/{room_id}/finish")

        pending = actor.get("/api/observations").json()["observations"]
        advantage = next((o for o in pending if o["type"] == "advantage"), None)
        if advantage is None:
            pytest.skip("本场 Mock 未产出优势观察")

        accepted = actor.post(f"/api/observations/{advantage['id']}/accept").json()
        assert accepted["created"]["kind"] == "advantage"
        return accepted["created"]["id"]

    def test_confirm_then_remove(self, client, unique_name):
        actor = register(client, unique_name("adv"))
        adv_id = self._make_advantage(actor)

        confirmed = actor.post(f"/api/advantages/{adv_id}/confirm").json()
        assert confirmed["advantage"]["verified"] is True
        assert confirmed["advantage"]["status"] == "confirmed"

        removed = actor.post(f"/api/advantages/{adv_id}/remove").json()
        assert removed["ok"] is True

    def test_removed_advantage_not_resurrected(self, client, unique_name):
        """移除后 AI 不再重复入库同一标签——靠 status=removed 留痕实现。"""
        actor = register(client, unique_name("adv2"))
        adv_id = self._make_advantage(actor)
        name = next(
            a["name"]
            for a in actor.get("/api/advantages?status_filter=pending,confirmed").json()["advantages"]
            if a["id"] == adv_id
        )

        actor.post(f"/api/advantages/{adv_id}/remove")

        # 未确认/已确认列表里不该再出现
        listing = actor.get("/api/advantages?status_filter=pending,confirmed").json()
        assert all(a["id"] != adv_id for a in listing["advantages"])

        # 但归档里能找回，且可恢复
        assert any(a["id"] == adv_id for a in actor.get("/api/archive").json()["advantages"])
        restored = actor.post(f"/api/advantages/{adv_id}/restore").json()
        assert restored["advantage"]["status"] == "pending"
        assert restored["advantage"]["name"] == name

    def test_pending_advantage_not_auto_confirmed(self, client, unique_name):
        """方案 3.5：不弹窗、不打断、不强制——入库即 pending，绝不自动确认。"""
        actor = register(client, unique_name("adv3"))
        adv_id = self._make_advantage(actor)

        listing = actor.get("/api/advantages?status_filter=pending,confirmed").json()
        target = next(a for a in listing["advantages"] if a["id"] == adv_id)
        assert target["status"] == "pending"
        assert target["verified"] is False
        assert listing["pending_count"] >= 1


# ─────────────────────────────────────────────────────────────
# 原则库（方案 3.6）
# ─────────────────────────────────────────────────────────────


class TestPrinciples:
    def test_manual_principle_is_active_immediately(self, client, unique_name):
        actor = register(client, unique_name("prin"))
        response = actor.post("/api/principles", json={"content": "先承认，再补充"})
        assert response.status_code == 201
        assert response.json()["principle"]["status"] == "active"

    def test_principle_can_link_multiple_loops(self, client, unique_name):
        actor = register(client, unique_name("link"))
        w = make_weakness(actor)
        loop1 = make_loop(actor, w["id"])
        loop2 = make_loop(actor, w["id"])

        created = actor.post("/api/principles", json={"content": "结论先行"}).json()["principle"]
        response = actor.patch(
            f"/api/principles/{created['id']}",
            json={"linked_loop_ids": [loop1["id"], loop2["id"]], "pinned": True},
        ).json()["principle"]

        assert len(response["linked_loop_ids"]) == 2
        assert response["pinned"] is True
        assert len(response["linked_loops"]) == 2

    def test_ignore_keeps_record(self, client, unique_name):
        """忽略是留痕，不是删除——AI 需要知道这条推过了。"""
        actor = register(client, unique_name("ign"))
        created = actor.post("/api/principles", json={"content": "被追问先复述"}).json()["principle"]

        actor.post(f"/api/principles/{created['id']}/ignore")

        archived = actor.get("/api/archive").json()["principles"]
        assert any(p["id"] == created["id"] for p in archived)

        # 且可恢复
        restored = actor.post(f"/api/principles/{created['id']}/restore").json()
        assert restored["principle"]["status"] == "active"


# ─────────────────────────────────────────────────────────────
# 状态栏与连续天数
# ─────────────────────────────────────────────────────────────


class TestStatusBar:
    def test_streak_counts_today_with_real_practice(self, client, unique_name):
        actor = register(client, unique_name("streak"))
        assert actor.get("/api/status-bar").json()["streak_days"] == 0

        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])
        actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "hold"})

        bar = actor.get("/api/status-bar").json()
        assert bar["streak_days"] == 1

    def test_energy_roundtrip_and_optional(self, client, unique_name):
        actor = register(client, unique_name("energy"))

        bar = actor.get("/api/status-bar").json()
        assert bar["energy"] is None  # 不填不显示

        saved = actor.post("/api/daily-state", json={"energy": 72}).json()
        assert saved["energy"] == 72
        assert saved["mood"] is None

        assert actor.get("/api/status-bar").json()["energy"] == 72

    def test_energy_out_of_range_rejected(self, client, unique_name):
        actor = register(client, unique_name("range"))
        assert actor.post("/api/daily-state", json={"energy": 101}).status_code == 422

    def test_today_loops_capped_at_two(self, client, unique_name):
        """方案 3.7：今天练什么最多 2 条回环。"""
        actor = register(client, unique_name("cap"))
        weakness = make_weakness(actor)
        for _ in range(3):
            make_loop(actor, weakness["id"])

        bar = actor.get("/api/status-bar").json()
        assert len(bar["today_loops"]) <= 2

    def test_broken_loop_still_shows_on_home(self, client, unique_name):
        """破功后回环进入待修订，仍必须出现在「今天练什么」。

        这是真实踩过的坑：破功恰恰是最该被看见的时刻，
        如果这时把回环从首页拿掉，用户会以为无事可做。
        """
        actor = register(client, unique_name("broken"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        assert len(actor.get("/api/status-bar").json()["today_loops"]) == 1

        actor.post(f"/api/loops/{loop['id']}/logs", json={"result": "break"})

        bar = actor.get("/api/status-bar").json()
        assert len(bar["today_loops"]) == 1
        assert bar["today_loops"][0]["loop_id"] == loop["id"]

    def test_paused_loop_hidden_from_home(self, client, unique_name):
        """方案 3.3：暂停后不推送演练——所以首页也不该再推它。"""
        actor = register(client, unique_name("paused"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        actor.patch(f"/api/loops/{loop['id']}", json={"status": "paused"})

        bar = actor.get("/api/status-bar").json()
        assert bar["today_loops"] == []


# ─────────────────────────────────────────────────────────────
# 事件卡（方案 3.4）
# ─────────────────────────────────────────────────────────────


class TestEventCards:
    def test_full_mode_writes_log_immediately(self, client, unique_name):
        actor = register(client, unique_name("card"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        response = actor.post(
            "/api/event-cards",
            json={
                "content": "开会时被追问，我先承认没想清楚",
                "linked_loop_ids": [loop["id"]],
                "result": "hold",
            },
        ).json()

        assert response["card"]["analyzed"] is True
        assert response["card"]["pending_confirm"] is False
        assert len(response["created_logs"]) == 1
        assert response["created_logs"][0]["result"] == "hold"

        # 演练计数应增加
        detail = actor.get(f"/api/weaknesses/{weakness['id']}").json()
        assert detail["weakness"]["drill_count"] == 1

    def test_minimal_mode_marks_pending_confirm(self, client, unique_name):
        actor = register(client, unique_name("mini"))
        response = actor.post(
            "/api/event-cards", json={"content": "今天开会有点烦"}
        ).json()

        assert response["card"]["pending_confirm"] is True
        assert response["created_logs"] == []

    def test_manual_analyze_runs(self, client, unique_name):
        actor = register(client, unique_name("scan"))
        weakness = make_weakness(actor)
        make_loop(actor, weakness["id"])

        for text in ["开会被打断", "开会又被追问", "讨论时被打断思路"]:
            actor.post("/api/event-cards", json={"content": text})

        result = actor.post("/api/event-cards/analyze").json()
        assert result["scanned"] >= 3
        assert "cards_analyzed" in result


# ─────────────────────────────────────────────────────────────
# 辩论房：辩题来源、参数别名、多人权限
# ─────────────────────────────────────────────────────────────


class TestDebateEntry:
    def test_topic_can_be_generated_from_scene(self, client, unique_name):
        """方案 3.1 的 P0：用户往往说不出辩题，只会说发生了什么。

        这条用例锁住的是「只给 scene 也要能开起来」——
        早期实现只在带 loop_id/weakness_id 时才肯生成辩题，
        用户直接描述场景会被 400 挡回去。
        """
        actor = register(client, unique_name("scene"))
        response = actor.post(
            "/api/debates",
            json={"scene": "今天开会我又被领导当众追问进度，一下子没接住"},
        )
        assert response.status_code == 201, response.text

        room = response.json()["room"]
        assert room["topic"], "应当由 AI 生成辩题"
        assert room["stance"], "应当由 AI 生成建议立场"
        assert 4 <= room["max_rounds"] <= 8
        assert response.json()["first_message"]["role"] == "ai"

    def test_neither_topic_nor_scene_rejected(self, client, unique_name):
        actor = register(client, unique_name("empty"))
        response = actor.post("/api/debates", json={})
        assert response.status_code == 400
        assert "scene" in response.json()["detail"]

    def test_list_accepts_both_status_and_status_filter(self, client, unique_name):
        """status 与 status_filter 都必须被接受。

        参数名写错不会报错、只会返回全部数据，是最难发现的一类缺陷。
        """
        actor = register(client, unique_name("alias"))
        actor.post("/api/debates", json={"topic": "该不该当场反驳", "stance": "该"})

        by_status = actor.get("/api/debates?status=active").json()
        by_filter = actor.get("/api/debates?status_filter=active").json()
        assert by_status["total"] == by_filter["total"] >= 1

        # finished 应该过滤掉进行中的
        finished = actor.get("/api/debates?status=finished").json()
        assert finished["total"] == 0


class TestDebateMultiUser:
    def _make_room(self, actor) -> dict:
        response = actor.post(
            "/api/debates",
            json={"topic": "该不该在会上直接反驳领导", "stance": "该"},
        )
        assert response.status_code == 201, response.text
        return response.json()["room"]

    def test_invitee_cannot_see_owner_private_context(self, client, unique_name):
        """方案 3.1：被邀请者看不到发起人的弱点标签、回环、AI 观察。"""
        alice = register(client, unique_name("own"))
        weakness = make_weakness(alice)
        loop = make_loop(alice, weakness["id"])
        room = self._make_room(alice)

        # 发起人视角：能看到 loop / weakness
        owner_view = alice.get(f"/api/debates/{room['id']}").json()["room"]
        assert owner_view["is_owner"] is True

        invite = alice.post(f"/api/debates/{room['id']}/invite").json()
        # 邀请响应字段名必须是 invite_token（不是 token，避免与认证令牌混淆）
        assert "invite_token" in invite
        assert invite["max_participants"] == 4
        assert invite["link"].endswith(f"/debate/join/{invite['invite_token']}")

        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("inv"), invite_code=code)

        joined = bob.post(f"/api/debates/join/{invite['invite_token']}")
        assert joined.status_code == 200, joined.text
        assert joined.json()["room"]["is_owner"] is False

        bob_view = bob.get(f"/api/debates/{room['id']}").json()
        assert bob_view["room"]["is_owner"] is False
        assert bob_view["room"]["loop_id"] is None
        assert bob_view["room"]["weakness_id"] is None
        assert "review" not in bob_view, "AI 观察与复盘只对发起人可见"

    def test_outsider_cannot_read_room(self, client, unique_name):
        alice = register(client, unique_name("a3"))
        room = self._make_room(alice)

        code = alice.get("/api/auth/invite").json()["code"]
        carol = register(client, unique_name("c3"), invite_code=code)

        assert carol.get(f"/api/debates/{room['id']}").status_code == 403

    def test_invalid_invite_token_rejected(self, client, unique_name):
        actor = register(client, unique_name("bad"))
        assert actor.post("/api/debates/join/not-a-real-token").status_code == 404

    def test_pause_and_resume(self, client, unique_name):
        """方案 3.1：用户可暂停查资料，回来继续。"""
        actor = register(client, unique_name("pause"))
        room = self._make_room(actor)

        assert actor.post(f"/api/debates/{room['id']}/pause").json()["status"] == "paused"
        blocked = actor.post(
            f"/api/debates/{room['id']}/messages", json={"content": "还在吗"}
        )
        assert blocked.status_code == 409

        assert actor.post(f"/api/debates/{room['id']}/resume").json()["status"] == "active"
        ok = actor.post(f"/api/debates/{room['id']}/messages", json={"content": "继续"})
        assert ok.status_code == 201


class TestLoopListing:
    def test_global_loop_list_avoids_n_plus_one(self, client, unique_name):
        """原则库要「一条原则关联多个回环」，需要一个全局回环列表。

        没有它，前端只能先拉弱点列表再逐个拉详情去凑——
        20 个弱点就是 21 次请求。
        """
        actor = register(client, unique_name("loops"))
        weakness = make_weakness(actor)
        loop1 = make_loop(actor, weakness["id"])
        loop2 = make_loop(actor, weakness["id"])

        # 另一个弱点下的回环也应出现在全量列表里
        weakness2 = make_weakness(actor, name="计划外变化容易焦躁")
        loop3 = make_loop(actor, weakness2["id"])

        payload = actor.get("/api/loops").json()
        ids = {item["id"] for item in payload["loops"]}
        assert {loop1["id"], loop2["id"], loop3["id"]} <= ids
        assert payload["total"] == len(payload["loops"])

        # 每条都带得出所属弱点名称，前端不用再补请求
        assert all(item["weakness_name"] for item in payload["loops"])

    def test_filter_by_weakness_and_status(self, client, unique_name):
        actor = register(client, unique_name("fil"))
        weakness = make_weakness(actor)
        active_loop = make_loop(actor, weakness["id"])
        draft_loop = make_loop(actor, weakness["id"], activate=False)

        scoped = actor.get(f"/api/loops?weakness_id={weakness['id']}").json()
        assert scoped["total"] == 2

        only_active = actor.get(f"/api/loops?status=active&weakness_id={weakness['id']}").json()
        assert {item["id"] for item in only_active["loops"]} == {active_loop["id"]}

        # status 与 status_filter 等价
        alias = actor.get(f"/api/loops?status_filter=active&weakness_id={weakness['id']}").json()
        assert alias["total"] == only_active["total"]

        only_draft = actor.get(f"/api/loops?status=draft&weakness_id={weakness['id']}").json()
        assert {item["id"] for item in only_draft["loops"]} == {draft_loop["id"]}

    def test_other_user_loops_not_visible(self, client, unique_name):
        alice = register(client, unique_name("la"))
        weakness = make_weakness(alice)
        make_loop(alice, weakness["id"])

        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("lb"), invite_code=code)

        assert bob.get("/api/loops").json()["total"] == 0
