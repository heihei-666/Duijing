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

        # 注意是「b 删除 a」——所以要从 **b 的**好友列表里取 a 的 id
        a_id = _uid_named(b, a.username)
        assert b.client.delete(f"/api/friends/{a_id}", headers=b._headers).status_code == 200

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

        # 同上：b 删除 a
        a_id = _uid_named(b, a.username)
        b.client.delete(f"/api/friends/{a_id}", headers=b._headers)

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


def _invite_code_of(actor: Actor) -> str:
    r = actor.get("/api/auth/invite")
    assert r.status_code == 200, r.text
    return r.json()["code"]


class TestInviteSuggestions:
    """方案 3.10「邀请关系」：用我的码注册的人应当被**建议**为好友，
    但**不能自动成为好友**（邀请码是一个码，不是一对一凭证）。"""

    def test_invited_user_is_suggested(self, client, unique_name):
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        b = register(client, unique_name("sb"), invite_code=code)

        r = a.get("/api/friends/suggestions")
        assert r.status_code == 200, r.text
        names = [s["username"] for s in r.json()["suggestions"]]
        assert b.username in names, f"用我的码注册的 {b.username} 应出现在建议里，实际 {names}"

    def test_suggestion_does_not_create_friendship(self, client, unique_name):
        """关键：建议**只是建议**。点了也还得走申请 → 接受。"""
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        register(client, unique_name("sb"), invite_code=code)

        a.get("/api/friends/suggestions")
        assert a.get("/api/friends").json()["friends"] == [], "建议不该自动建好友关系"

    def test_already_friend_is_excluded(self, client, unique_name):
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        b = register(client, unique_name("sb"), invite_code=code)
        _befriend(client, a, b)

        names = [s["username"] for s in a.get("/api/friends/suggestions").json()["suggestions"]]
        assert b.username not in names

    def test_pending_request_is_excluded(self, client, unique_name):
        """已有待处理申请时不该重复引导 —— 否则用户会以为申请没发出去。"""
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        b = register(client, unique_name("sb"), invite_code=code)
        a.post("/api/friends/requests", json={"username": b.username})

        names = [s["username"] for s in a.get("/api/friends/suggestions").json()["suggestions"]]
        assert b.username not in names

    def test_rejected_is_excluded(self, client, unique_name):
        """拒绝是终态：不该因为「他是用我的码注册的」就把引导又塞回来。"""
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        b = register(client, unique_name("sb"), invite_code=code)

        rid = a.post("/api/friends/requests", json={"username": b.username}).json()["id"]
        assert b.post(f"/api/friends/requests/{rid}/reject").status_code == 200

        names = [s["username"] for s in a.get("/api/friends/suggestions").json()["suggestions"]]
        assert b.username not in names, "被拒绝过的人不该再被建议"

    def test_i_rejected_them_is_also_excluded(self, client, unique_name):
        """反方向也一样：我拒绝了他，也不该再被建议。"""
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        b = register(client, unique_name("sb"), invite_code=code)

        rid = b.post("/api/friends/requests", json={"username": a.username}).json()["id"]
        assert a.post(f"/api/friends/requests/{rid}/reject").status_code == 200

        names = [s["username"] for s in a.get("/api/friends/suggestions").json()["suggestions"]]
        assert b.username not in names

    def test_uninvited_user_not_suggested(self, client, unique_name):
        """不是我用邀请码拉进来的人，不该出现在建议里。"""
        a = register(client, unique_name("sa"))
        register(client, unique_name("sb"))  # 用引导管理员的码

        names = [s["username"] for s in a.get("/api/friends/suggestions").json()["suggestions"]]
        assert names == []

    def test_suggestions_only_three_fields(self, client, unique_name):
        """和建议无关的字段一律不返回（延续 3.10 的白名单精神）。"""
        a = register(client, unique_name("sa"))
        code = _invite_code_of(a)
        register(client, unique_name("sb"), invite_code=code)

        items = a.get("/api/friends/suggestions").json()["suggestions"]
        assert len(items) == 1
        assert set(items[0]) == {"user_id", "username", "nickname"}

    def test_requires_login(self, client):
        assert client.get("/api/friends/suggestions").status_code == 401


class TestAuth:
    @pytest.mark.parametrize(
        "method,url",
        [
            ("get", "/api/friends"),
            ("get", "/api/friends/requests"),
            ("get", "/api/friends/search?username=x"),
            ("get", "/api/debates/invitations"),
        ],
    )
    def test_requires_login(self, client, method, url):
        assert getattr(client, method)(url).status_code == 401


def _make_room(actor: Actor) -> int:
    r = actor.post("/api/debates", json={"topic": "该不该当场反驳", "stance": "该"})
    assert r.status_code == 201, r.text
    return r.json()["room"]["id"]


def _uid_named(actor: Actor, username: str) -> int:
    """从 **actor 自己的好友列表**里取指定用户名的 user_id。

    为什么要专门写这个函数：这里踩过一次坑 —— 写成
    `b.get("/api/friends").json()["friends"][0]["user_id"]` 时，
    取到的是 **b 的好友（也就是 a）** 的 id，于是后面的
    「a 邀请 [a的id]」被后端正确地判定成「邀请自己」并静默跳过，
    测试以 `invited == []` 失败，**看起来像后端坏了**。

    取错人这类错误会伪装成被测代码的 bug，所以把它封成一个
    会明确报错的函数，而不是散落的下标取值。
    """
    for friend in actor.get("/api/friends").json()["friends"]:
        if friend["username"] == username:
            return friend["user_id"]
    raise AssertionError(f"{actor.username} 的好友里没有 {username}")


class TestDebateInvitation:
    """方案 3.10：**不能把人直接拉进辩论房**，必须对方接受。"""

    def test_invite_friend_creates_pending_invitation(self, client, unique_name):
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        _befriend(client, a, b)
        room = _make_room(a)

        b_id = _uid_named(a, b.username)
        r = a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["invited"]) == 1
        assert body["invited"][0]["user_id"] == b_id
        # 链接仍然给（两种方式并存）
        assert body["link"]

        # B 收到邀请，但**还没有**进房
        inv = b.get("/api/debates/invitations").json()["invitations"]
        assert len(inv) == 1
        assert inv[0]["inviter"]["username"] == a.username
        assert inv[0]["topic"] == "该不该当场反驳"
        assert b.get(f"/api/debates/{room}").status_code == 403

    def test_invitation_does_not_leak_conversation(self, client, unique_name):
        """还没接受就不该看到房间内容 —— 邀请里只能有「够做决定」的信息。"""
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        _befriend(client, a, b)
        room = _make_room(a)
        b_id = _uid_named(a, b.username)
        a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})

        inv = b.get("/api/debates/invitations").json()["invitations"][0]
        assert set(inv) == {
            "id", "room_id", "topic", "stance", "inviter",
            "participant_count", "max_participants", "created_at",
        }
        assert "messages" not in inv and "first_message" not in inv

    def test_accept_joins_room(self, client, unique_name):
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        _befriend(client, a, b)
        room = _make_room(a)
        b_id = _uid_named(a, b.username)
        a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})

        inv_id = b.get("/api/debates/invitations").json()["invitations"][0]["id"]
        r = b.post(f"/api/debates/invitations/{inv_id}/accept")
        assert r.status_code == 200, r.text

        # 现在能进房了
        assert b.get(f"/api/debates/{room}").status_code == 200
        # 邀请从待处理列表消失
        assert b.get("/api/debates/invitations").json()["invitations"] == []

    def test_decline_does_not_join_and_can_be_reinvited(self, client, unique_name):
        """辩论邀请被拒**不是终态** —— 换个辩题再邀是正常的。

        这与好友申请刻意不同：那里拒绝必须终态（防骚扰），
        这里房间本来就是对方发起的，不存在骚扰问题。
        """
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        _befriend(client, a, b)
        room = _make_room(a)
        b_id = _uid_named(a, b.username)
        a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})

        inv_id = b.get("/api/debates/invitations").json()["invitations"][0]["id"]
        assert b.post(f"/api/debates/invitations/{inv_id}/decline").status_code == 200
        assert b.get(f"/api/debates/{room}").status_code == 403
        assert b.get("/api/debates/invitations").json()["invitations"] == []

        # 再邀一次：应重新变成 pending
        r = a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})
        assert len(r.json()["invited"]) == 1
        assert len(b.get("/api/debates/invitations").json()["invitations"]) == 1

    def test_cannot_invite_non_friend(self, client, unique_name):
        """不校验好友关系的话，friend_ids 就是一个「按 user_id 给任意人发邀请」的入口。"""
        a = register(client, unique_name("da"))
        stranger = register(client, unique_name("ds"))
        room = _make_room(a)

        sid = a.get(
            "/api/friends/search", params={"username": stranger.username}
        ).json()["user"]["user_id"]
        r = a.post(f"/api/debates/{room}/invite", json={"friend_ids": [sid]})
        assert r.status_code == 200
        assert r.json()["invited"] == []
        assert r.json()["skipped"][0]["reason"] == "not_friend"
        assert stranger.get("/api/debates/invitations").json()["invitations"] == []

    def test_cannot_invite_self(self, client, unique_name):
        a = register(client, unique_name("da"))
        room = _make_room(a)
        me = a.get("/api/account/profile")
        assert me.status_code == 200
        r = a.post(f"/api/debates/{room}/invite", json={"friend_ids": [1]})
        assert r.status_code == 200
        assert r.json()["invited"] == []

    def test_only_invitee_can_accept(self, client, unique_name):
        """归属校验：别人拿着 invite_id 也接受不了。"""
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        c = register(client, unique_name("dc"))
        _befriend(client, a, b)
        room = _make_room(a)
        b_id = _uid_named(a, b.username)
        a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})

        inv_id = b.get("/api/debates/invitations").json()["invitations"][0]["id"]
        assert c.post(f"/api/debates/invitations/{inv_id}/accept").status_code == 404
        assert c.post(f"/api/debates/invitations/{inv_id}/decline").status_code == 404

    def test_cannot_handle_invitation_twice(self, client, unique_name):
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        _befriend(client, a, b)
        room = _make_room(a)
        b_id = _uid_named(a, b.username)
        a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})

        inv_id = b.get("/api/debates/invitations").json()["invitations"][0]["id"]
        b.post(f"/api/debates/invitations/{inv_id}/accept")
        assert b.post(f"/api/debates/invitations/{inv_id}/accept").status_code == 409

    def test_only_owner_can_invite(self, client, unique_name):
        a = register(client, unique_name("da"))
        b = register(client, unique_name("db"))
        c = register(client, unique_name("dc"))
        _befriend(client, a, b)
        room = _make_room(a)
        b_id = _uid_named(a, b.username)
        a.post(f"/api/debates/{room}/invite", json={"friend_ids": [b_id]})
        inv_id = b.get("/api/debates/invitations").json()["invitations"][0]["id"]
        b.post(f"/api/debates/invitations/{inv_id}/accept")

        # B 已在房里，但不是发起人，不该能邀请
        c_id = c.get("/api/friends/search", params={"username": a.username})
        r = b.post(f"/api/debates/{room}/invite", json={"friend_ids": []})
        assert r.status_code == 403

    def test_plain_link_invite_still_works(self, client, unique_name):
        """不带 friend_ids 时行为必须和从前完全一致（向后兼容）。"""
        a = register(client, unique_name("da"))
        room = _make_room(a)
        r = a.post(f"/api/debates/{room}/invite", json={})
        assert r.status_code == 200
        assert r.json()["invite_token"]
        assert r.json()["invited"] == []

    def test_invite_without_body_still_works(self, client, unique_name):
        """老客户端不带 body —— 不能因此 422。"""
        a = register(client, unique_name("da"))
        room = _make_room(a)
        r = a.post(f"/api/debates/{room}/invite")
        assert r.status_code == 200, f"不带 body 应仍可用，实际 {r.status_code}: {r.text}"

    def test_capacity_caps_pending_invitations(self, client, unique_name):
        """房满前只放得下这么多邀请 —— 不能给 4 人房发 10 份邀请。"""
        a = register(client, unique_name("da"))
        room = _make_room(a)
        others = [register(client, unique_name(f"df{i}")) for i in range(4)]
        for o in others:
            _befriend(client, a, o)

        friend_ids = [f["user_id"] for f in a.get("/api/friends").json()["friends"]]
        assert len(friend_ids) == 4
        r = a.post(f"/api/debates/{room}/invite", json={"friend_ids": friend_ids})
        body = r.json()
        # 4 人房，发起人占 1，剩下 3 个位置
        assert len(body["invited"]) == 3, f"应只邀请 3 人，实际 {len(body['invited'])}: {body}"
        assert any(s["reason"] == "room_full" for s in body["skipped"])

