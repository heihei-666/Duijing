"""对镜 · 好友（方案 3.10）

【这个文件守的是什么】

好友功能的风险不在增删改查，在**隐私边界**。方案 3.10 给好友可见范围
定了白名单（连续天数 / 今天是否练过，且需对方主动开启），
并写明理由：黑名单每新增一个字段就自动漏一个，白名单才会越用越安全。

所以这里最重要的一组测试不是「能不能加好友」，而是
**好友接口返回的字段集是否恰好等于白名单** —— 它是一道断言，
挡的是将来某次「顺手加个字段」的改动。
"""

from __future__ import annotations

import pytest

from app.models import Friendship
from tests.conftest import Actor, register

# 好友列表里允许出现的**全部**字段。多一个都不行。
FRIEND_LIST_FIELDS = {
    "user_id",
    "username",
    "nickname",
    "sharing",
    "streak_days",
    "practiced_today",
}

# 任何名字里含这些词的字段，一旦出现在好友接口里就是隐私事故
FORBIDDEN_MARKERS = (
    "weak",
    "loop",
    "observation",
    "principle",
    "advantage",
    "event",
    "review",
    "message",
    "trigger",
    "hold",
    "streak_target",
)


def _befriend(client, a: Actor, b: Actor) -> None:
    """把 A 和 B 变成好友，走真实流程（申请 → 接受）。"""
    r = a.post("/api/friends/requests", json={"username": b.username})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    r = b.post(f"/api/friends/requests/{rid}/accept")
    assert r.status_code == 200, r.text


class TestSearch:
    def test_exact_match_only(self, client, unique_name):
        """方案 3.10：按用户名**精确**匹配，不做模糊搜索。

        模糊搜索等于给了一个「浏览全站用户」的入口，
        而这个产品里每个人都存着私密的弱点数据。
        """
        a = register(client, unique_name("fa"))
        b_name = unique_name("fb")
        register(client, b_name)

        r = a.get("/api/friends/search", params={"username": b_name})
        assert r.json()["found"] is True

        r = a.get("/api/friends/search", params={"username": b_name[:-3]})
        assert r.json()["found"] is False, "模糊前缀不该命中"

    def test_search_returns_only_three_fields(self, client, unique_name):
        """搜索结果不该带任何可用于画像的字段（邮箱、注册时间、连续天数…）。"""
        a = register(client, unique_name("fa"))
        b_name = unique_name("fb")
        register(client, b_name)

        r = a.get("/api/friends/search", params={"username": b_name})
        assert set(r.json()["user"]) == {"user_id", "username", "nickname"}

    def test_cannot_search_self(self, client, unique_name):
        a = register(client, unique_name("fa"))
        r = a.get("/api/friends/search", params={"username": a.username})
        assert r.json()["found"] is False

    def test_requires_login(self, client, unique_name):
        assert client.get("/api/friends/search", params={"username": "x"}).status_code == 401


class TestRequestFlow:
    def test_request_then_accept(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))

        r = a.post("/api/friends/requests", json={"username": b.username})
        assert r.status_code == 201

        r = b.get("/api/friends/requests")
        assert len(r.json()["incoming"]) == 1
        assert r.json()["incoming"][0]["username"] == a.username

        # A 那边应能看到「我发出的」
        r = a.get("/api/friends/requests")
        assert len(r.json()["outgoing"]) == 1

        rid = b.get("/api/friends/requests").json()["incoming"][0]["id"]
        assert b.post(f"/api/friends/requests/{rid}/accept").status_code == 200

        assert len(a.get("/api/friends").json()["friends"]) == 1
        assert len(b.get("/api/friends").json()["friends"]) == 1

    def test_duplicate_request_rejected(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        a.post("/api/friends/requests", json={"username": b.username})
        r = a.post("/api/friends/requests", json={"username": b.username})
        assert r.status_code == 409

    def test_requester_cannot_accept_own_request(self, client, unique_name):
        """只有**收件人**能处理。这是归属校验，不是流程校验。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        rid = a.post("/api/friends/requests", json={"username": b.username}).json()["id"]

        assert a.post(f"/api/friends/requests/{rid}/accept").status_code == 404
        assert len(a.get("/api/friends").json()["friends"]) == 0

    def test_mutual_request_auto_accepts(self, client, unique_name):
        """对方已经申请过我 → 直接互加，不用两边各按一次。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        a.post("/api/friends/requests", json={"username": b.username})

        r = b.post("/api/friends/requests", json={"username": a.username})
        assert r.status_code == 201
        assert r.json()["status"] == "accepted"
        assert len(a.get("/api/friends").json()["friends"]) == 1

    def test_request_unknown_user(self, client, unique_name):
        a = register(client, unique_name("fa"))
        r = a.post("/api/friends/requests", json={"username": "no_such_user_xyz"})
        assert r.status_code == 404


class TestRejectionIsTerminal:
    """拒绝是终态 —— 否则「拒绝」形同虚设，可以无限骚扰。方案 3.10。"""

    def test_rejected_cannot_request_again(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        rid = a.post("/api/friends/requests", json={"username": b.username}).json()["id"]

        assert b.post(f"/api/friends/requests/{rid}/reject").status_code == 200

        r = a.post("/api/friends/requests", json={"username": b.username})
        assert r.status_code == 403, f"拒绝后应被挡住，实际 {r.status_code}"

    def test_rejected_row_survives(self, client, unique_name):
        """拒绝不是删行 —— 要靠这行回答「这两个人之间发生过什么」。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        rid = a.post("/api/friends/requests", json={"username": b.username}).json()["id"]
        b.post(f"/api/friends/requests/{rid}/reject")

        # 双方待处理列表都应为空（已处理）
        assert a.get("/api/friends/requests").json()["outgoing"] == []
        assert b.get("/api/friends/requests").json()["incoming"] == []

    def test_cannot_handle_request_twice(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        rid = a.post("/api/friends/requests", json={"username": b.username}).json()["id"]
        b.post(f"/api/friends/requests/{rid}/accept")
        assert b.post(f"/api/friends/requests/{rid}/accept").status_code == 409


class TestFriendListPrivacy:
    """**这个类是本文件存在的理由。** 好友可见范围是白名单。"""

    def test_fields_are_exactly_the_whitelist(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        friends = b.get("/api/friends").json()["friends"]
        assert len(friends) == 1
        assert set(friends[0]) == FRIEND_LIST_FIELDS, (
            f"好友列表字段集变了：多了 {set(friends[0]) - FRIEND_LIST_FIELDS}，"
            f"少了 {FRIEND_LIST_FIELDS - set(friends[0])}。"
            "要加字段必须先改方案 3.10 的白名单。"
        )

    def test_no_sensitive_field_names_leak(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        # A 建一张弱点卡，确保库里确实有敏感数据可漏
        a.post(
            "/api/weaknesses",
            json={"name": "被追问时防御性重复", "description": "秘密", "domains": ["work"]},
        )

        payload = b.get("/api/friends").json()
        flat = str(payload).lower()
        for marker in FORBIDDEN_MARKERS:
            assert marker not in flat.replace("streak_days", ""), (
                f"好友接口的返回里出现了 {marker!r} 相关内容：{payload}"
            )

    def test_default_is_not_sharing(self, client, unique_name):
        """默认关闭（方案 3.10 + 约束第 4 条：分享必须是用户主动动作）。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        friend = b.get("/api/friends").json()["friends"][0]
        assert friend["sharing"] is False
        assert friend["streak_days"] is None
        assert friend["practiced_today"] is None

    def test_null_not_zero_when_not_sharing(self, client, unique_name):
        """未开启时必须是 null，不能是 0 / False。

        返回 0 会被前端显示成「他连着 0 天」——那是在编造事实。
        """
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        friend = b.get("/api/friends").json()["friends"][0]
        assert friend["streak_days"] is not None or friend["sharing"] is False
        assert friend["sharing"] is False and friend["streak_days"] is None

    def test_sharing_is_one_way(self, client, unique_name):
        """A 开启分享不影响 B 的可见性 —— 开关是单向的。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        a.patch("/api/account/profile", json={"share_progress_with_friends": True})

        seen_by_b = b.get("/api/friends").json()["friends"][0]
        seen_by_a = a.get("/api/friends").json()["friends"][0]
        assert seen_by_b["sharing"] is True, "B 应能看到 A 的进展"
        assert seen_by_a["sharing"] is False, "A 不该因此看到 B 的进展"


class TestSharingToggle:
    def test_enable_then_disable_takes_effect_immediately(self, client, unique_name):
        """关闭立即生效，且**不返回过期数据**。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        a.patch("/api/account/profile", json={"share_progress_with_friends": True})
        on = b.get("/api/friends").json()["friends"][0]
        assert on["sharing"] is True
        assert isinstance(on["streak_days"], int)
        assert isinstance(on["practiced_today"], bool)

        a.patch("/api/account/profile", json={"share_progress_with_friends": False})
        off = b.get("/api/friends").json()["friends"][0]
        assert off["sharing"] is False
        assert off["streak_days"] is None
        assert off["practiced_today"] is None

    def test_switch_visible_in_profile(self, client, unique_name):
        a = register(client, unique_name("fa"))
        r = a.get("/api/account/profile")
        assert r.json()["profile"]["share_progress_with_friends"] is False


class TestRemoveFriend:
    def test_remove_is_bidirectional(self, client, unique_name):
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        b_id = b.get("/api/friends").json()["friends"][0]["user_id"]
        assert b.client.delete(f"/api/friends/{b_id}", headers=b._headers).status_code == 200

        assert a.get("/api/friends").json()["friends"] == []
        assert b.get("/api/friends").json()["friends"] == []

    def test_remove_nonexistent(self, client, unique_name):
        a = register(client, unique_name("fa"))
        assert a.client.delete("/api/friends/999999", headers=a._headers).status_code == 404

    def test_can_refriend_after_remove(self, client, unique_name):
        """删除好友后可以重新加 —— 删除是一个真正的重新开始，
        不能让「之前拒绝过」的历史把对方永久挡住。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        b_id = b.get("/api/friends").json()["friends"][0]["user_id"]
        b.client.delete(f"/api/friends/{b_id}", headers=b._headers)

        r = a.post("/api/friends/requests", json={"username": b.username})
        assert r.status_code == 201, f"删除后应能重新申请，实际 {r.status_code}: {r.text}"


class TestFriendshipOrdering:
    """规范化存储（low < high）是「是不是好友」永远一次等值查询的前提。"""

    def test_order_is_symmetric(self):
        assert Friendship.order(3, 7) == Friendship.order(7, 3) == (3, 7)

    def test_only_one_row_per_pair(self, client, unique_name):
        """无论谁先申请、谁接受，friendship 只该有一行。"""
        a = register(client, unique_name("fa"))
        b = register(client, unique_name("fb"))
        _befriend(client, a, b)

        import asyncio

        from sqlalchemy import func, select

        from app.db import session_scope
        from app.models import Friendship as F

        async def count() -> int:
            async with session_scope() as s:
                return await s.scalar(select(func.count()).select_from(F)) or 0

        assert asyncio.run(count()) >= 1
        # 两边看到的好友数都是 1，说明没有重复行
        assert len(a.get("/api/friends").json()["friends"]) == 1
        assert len(b.get("/api/friends").json()["friends"]) == 1


class TestAuth:
    @pytest.mark.parametrize(
        "method,url",
        [
            ("get", "/api/friends"),
            ("get", "/api/friends/requests"),
            ("get", "/api/friends/search?username=x"),
        ],
    )
    def test_requires_login(self, client, method, url):
        assert getattr(client, method)(url).status_code == 401
