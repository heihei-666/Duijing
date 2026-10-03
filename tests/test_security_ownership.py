"""对镜 · 归属（越权）回归测试

这一组用例锁的是**同一条不变量**：

    「用户的私有数据，只能被他自己的请求读到；别人把 ID 填进请求体也没用。」

为什么单独开一个文件：2026-10-03 的外部审查发现并复现了 4 条越权路径，
它们分散在 debates / weaknesses / principles / push 四个模块里，
而当时的 `TestPrivacy` 只覆盖了「读接口」——**写接口传别人 ID** 这条路是空的。

每条用例都对应审查报告里的一个编号，改代码时别把哪条弄丢了。
"""

from __future__ import annotations

import pytest

from app.config import settings
from tests.conftest import make_loop, make_weakness, register


def _make_advantage(actor) -> int:
    """通过一场真实辩论产出优势观察，再接受它变成优势。

    刻意**不直接写库**：跨事件循环直连 async engine 会让 aiosqlite
    挂在不同的 loop 上，是典型的 flaky 来源（`test_core_rules.TestAdvantages`
    里有同样的注释）。
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


# ─────────────────────────────────────────────────────────────
# A-1  POST /api/archive/purge 曾经是「任何登录用户 → 全站物理删除」
# ─────────────────────────────────────────────────────────────


class TestPurgeIsScopedToCaller:
    def test_purge_only_deletes_my_own_expired_weaknesses(
        self, client, unique_name, monkeypatch
    ):
        """把倒计时改成负数，让弱点一归档就是「已过期」。

        不能只断言 deleted==0——那样区分不了「按用户过滤了」和「什么都没删」。
        """
        monkeypatch.setattr(settings, "WEAKNESS_DELETE_DAYS", -1)

        alice = register(client, unique_name("purge_a"))
        bob = register(client, unique_name("purge_b"))

        mine = make_weakness(alice, "A 的过期弱点")
        theirs = make_weakness(bob, "B 的过期弱点")

        assert alice.post(f"/api/weaknesses/{mine['id']}/archive").status_code == 200
        assert bob.post(f"/api/weaknesses/{theirs['id']}/archive").status_code == 200

        resp = alice.post("/api/archive/purge")
        assert resp.status_code in (200, 201), resp.text
        assert resp.json()["deleted"] == 1, "只应删掉调用者自己的那一条"

        # A 的已物理删除
        assert alice.get(f"/api/weaknesses/{mine['id']}").status_code == 404
        # B 的必须原封不动 —— 这正是修复前会挂掉的地方
        assert bob.get(f"/api/weaknesses/{theirs['id']}").status_code == 200

    def test_purge_requires_login(self, client):
        client.cookies.clear()
        assert client.post("/api/archive/purge").status_code == 401


# ─────────────────────────────────────────────────────────────
# A-2  建辩论时可以引用别人的弱点 / 回环
# ─────────────────────────────────────────────────────────────


class TestDebateSourceOwnership:
    """注意：`weakness_name` 只在**列表**和**详情**接口里填充（`debates.py:157-171`、
    `debates.py:389-392`），创建接口不填。所以断言必须打在详情/列表上——
    只断言创建响应等于什么都没测。"""

    @staticmethod
    def _detail_weakness_name(actor, room_id: int):
        resp = actor.get(f"/api/debates/{room_id}")
        assert resp.status_code == 200, resp.text
        return resp.json()["room"]["weakness_name"]

    def test_cannot_reference_another_users_weakness(self, client, unique_name):
        alice = register(client, unique_name("debw_a"))
        bob = register(client, unique_name("debw_b"))
        victim = make_weakness(bob, "B 的私密弱点：被追问就防御")

        resp = alice.post(
            "/api/debates",
            json={"topic": "该不该当场反驳", "stance": "该", "weakness_id": victim["id"]},
        )
        assert resp.status_code in (200, 201), resp.text
        room = resp.json()["room"]

        assert self._detail_weakness_name(alice, room["id"]) is None, (
            "别人的弱点名不能出现在自己的房间详情里"
        )
        assert "B 的私密弱点" not in alice.get(f"/api/debates/{room['id']}").text

        # 列表接口是第二个出口，同样不能泄露
        listed = alice.get("/api/debates").json()["rooms"]
        assert all(r["weakness_name"] is None for r in listed)

    def test_cannot_reference_another_users_loop(self, client, unique_name):
        """loop_id 这条更隐蔽：不校验的话会顺着回环把弱点也带出来。"""
        alice = register(client, unique_name("debl_a"))
        bob = register(client, unique_name("debl_b"))
        victim_card = make_weakness(bob, "B 的私密弱点：拖延")
        victim_loop = make_loop(bob, victim_card["id"])

        resp = alice.post(
            "/api/debates",
            json={"topic": "该不该当场反驳", "stance": "该", "loop_id": victim_loop["id"]},
        )
        assert resp.status_code in (200, 201), resp.text
        room = resp.json()["room"]

        assert self._detail_weakness_name(alice, room["id"]) is None
        assert "B 的私密弱点" not in alice.get(f"/api/debates/{room['id']}").text

    def test_source_id_path_is_still_guarded(self, client, unique_name):
        """第三个入口：source_type=weakness + source_id。"""
        alice = register(client, unique_name("debs_a"))
        bob = register(client, unique_name("debs_b"))
        victim = make_weakness(bob, "B 的私密弱点：怕否定")

        resp = alice.post(
            "/api/debates",
            json={
                "topic": "该不该当场反驳",
                "stance": "该",
                "source_type": "weakness",
                "source_id": victim["id"],
            },
        )
        assert resp.status_code in (200, 201), resp.text
        room = resp.json()["room"]
        assert self._detail_weakness_name(alice, room["id"]) is None
        assert "B 的私密弱点" not in alice.get(f"/api/debates/{room['id']}").text

    def test_own_weakness_still_works(self, client, unique_name):
        """回归护栏：加了归属校验之后，引用自己的弱点必须照常生效。

        这条同时证明了上面几条断言不是「因为永远拿不到 weakness_name 才通过」——
        我自己的弱点，名字必须能正常显示出来。
        """
        alice = register(client, unique_name("debw_ok"))
        mine = make_weakness(alice, "我自己的弱点：爱打断别人")

        resp = alice.post(
            "/api/debates",
            json={"topic": "该不该当场反驳", "stance": "该", "weakness_id": mine["id"]},
        )
        assert resp.status_code in (200, 201), resp.text
        room = resp.json()["room"]
        assert room["weakness_id"] == mine["id"]
        assert self._detail_weakness_name(alice, room["id"]) == "我自己的弱点：爱打断别人"


# ─────────────────────────────────────────────────────────────
# A-3  回环引用优势/原则、原则引用回环：写路径与读路径都要过滤
# ─────────────────────────────────────────────────────────────


class TestLoopLinkedAssets:
    def test_cannot_link_another_users_advantage(self, client, unique_name):
        alice = register(client, unique_name("link_a"))
        bob = register(client, unique_name("link_b"))

        bob_adv = _make_advantage(bob)
        mine = make_weakness(alice, "我的弱点：容易慌")

        resp = alice.post(
            f"/api/weaknesses/{mine['id']}/loops",
            json={
                "mode": "form",
                "trigger_scene": "临场被点名",
                "action_plan": "先深呼吸",
                "activate": True,
                "linked_advantage_ids": [bob_adv],
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["loop"]["linked_advantages"] == [], "不能挂别人的优势"

        # 写路径被过滤后，库里也不该留下这个 ID
        detail = alice.get(f"/api/weaknesses/{mine['id']}").json()
        for lp in detail["loops"]:
            assert lp["linked_advantages"] == []

    def test_cannot_link_another_users_principle(self, client, unique_name):
        alice = register(client, unique_name("linkp_a"))
        bob = register(client, unique_name("linkp_b"))

        created = bob.post("/api/principles", json={"content": "B 的原则：先复述再回答"})
        assert created.status_code in (200, 201), created.text
        bob_principle = created.json()["principle"]["id"]

        mine = make_weakness(alice, "我的弱点：答非所问")
        resp = alice.post(
            f"/api/weaknesses/{mine['id']}/loops",
            json={
                "mode": "form",
                "trigger_scene": "被问细节",
                "action_plan": "先复述问题",
                "activate": True,
                "linked_principle_ids": [bob_principle],
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["loop"]["linked_principles"] == []
        assert "B 的原则" not in resp.text

    def test_own_principle_still_links(self, client, unique_name):
        """回归护栏：引用自己的原则必须照常工作。"""
        alice = register(client, unique_name("linkp_ok"))
        mine_p = alice.post("/api/principles", json={"content": "我的原则：先确认事实"}).json()
        mine = make_weakness(alice, "我的弱点：急于下结论")

        resp = alice.post(
            f"/api/weaknesses/{mine['id']}/loops",
            json={
                "mode": "form",
                "trigger_scene": "被人否定",
                "action_plan": "先问依据",
                "activate": True,
                "linked_principle_ids": [mine_p["principle"]["id"]],
            },
        )
        assert resp.status_code == 201, resp.text
        linked = resp.json()["loop"]["linked_principles"]
        assert [p["id"] for p in linked] == [mine_p["principle"]["id"]]


class TestPrincipleLinkedLoops:
    def test_cannot_link_another_users_loop(self, client, unique_name):
        alice = register(client, unique_name("pl_a"))
        bob = register(client, unique_name("pl_b"))

        bob_card = make_weakness(bob, "B 的弱点：开会跑题")
        bob_loop = make_loop(bob, bob_card["id"])

        resp = alice.post(
            "/api/principles",
            json={"content": "先定议程再开会", "linked_loop_ids": [bob_loop["id"]]},
        )
        assert resp.status_code in (200, 201), resp.text
        principle = resp.json()["principle"]
        assert principle["linked_loop_ids"] == [], "别人的回环 ID 必须被丢掉"
        assert principle["linked_loops"] == []

        listed = alice.get("/api/principles").json()["principles"]
        for p in listed:
            assert p["linked_loops"] == []

    def test_cannot_patch_another_users_loop_into_principle(self, client, unique_name):
        """PATCH 是第二个写入口，很容易只修了 POST 忘了它。"""
        alice = register(client, unique_name("plp_a"))
        bob = register(client, unique_name("plp_b"))

        bob_card = make_weakness(bob, "B 的弱点：怕冲突")
        bob_loop = make_loop(bob, bob_card["id"])

        created = alice.post("/api/principles", json={"content": "先确认事实"}).json()["principle"]
        resp = alice.patch(
            f"/api/principles/{created['id']}", json={"linked_loop_ids": [bob_loop["id"]]}
        )
        assert resp.status_code in (200, 201), resp.text
        assert resp.json()["principle"]["linked_loop_ids"] == []

    def test_own_loop_still_links(self, client, unique_name):
        """回归护栏：关联自己的回环必须照常工作。"""
        alice = register(client, unique_name("pl_ok"))
        card = make_weakness(alice, "我的弱点：爱打断")
        lp = make_loop(alice, card["id"])

        resp = alice.post(
            "/api/principles", json={"content": "等对方说完", "linked_loop_ids": [lp["id"]]}
        )
        assert resp.status_code in (200, 201), resp.text
        principle = resp.json()["principle"]
        assert principle["linked_loop_ids"] == [lp["id"]]
        assert len(principle["linked_loops"]) == 1


# ─────────────────────────────────────────────────────────────
# A-3b push endpoint 换主：允许（同浏览器换账号），但不得跨界投递
# ─────────────────────────────────────────────────────────────


class TestPushEndpointTransfer:
    def test_transfer_moves_the_device_not_the_reminder(self, client, unique_name):
        """endpoint 属于浏览器，不属于账号；换账号后设备归新用户。

        关键不变量：旧用户此后**没有设备**了，
        所以他的提醒只会因「无设备」被标记失败，不会被投到新用户的浏览器上。
        """
        alice = register(client, unique_name("pushx_a"))
        bob = register(client, unique_name("pushx_b"))
        endpoint = f"https://fcm.googleapis.com/fcm/send/transfer-{unique_name('ep')}"
        body = {"endpoint": endpoint, "keys": {"p256dh": "BAbc", "auth": "xyz"}}

        assert alice.post("/api/push/subscribe", json=body).json()["device_count"] == 1
        assert alice.get("/api/push/status").json()["subscribed"] is True

        # 同一浏览器换 B 登录并订阅
        assert bob.post("/api/push/subscribe", json=body).json()["device_count"] == 1

        assert bob.get("/api/push/status").json()["subscribed"] is True
        assert alice.get("/api/push/status").json()["subscribed"] is False

    def test_transfer_keeps_a_single_row(self, client, unique_name):
        a = register(client, unique_name("pushy_a"))
        b = register(client, unique_name("pushy_b"))
        endpoint = f"https://fcm.googleapis.com/fcm/send/single-{unique_name('ep')}"
        body = {"endpoint": endpoint, "keys": {"p256dh": "k1", "auth": "a1"}}

        a.post("/api/push/subscribe", json=body)
        b.post("/api/push/subscribe", json=body)
        # endpoint 上有唯一约束，换主只能改行、不能新增行
        assert b.get("/api/push/status").json()["device_count"] == 1
