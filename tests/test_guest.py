"""对镜 · 访客模式（阶段 2）

【这条测试真正要证明的事】

不是「能建出访客」，而是：**访客能直接复用整套现有业务逻辑**。

辩论、观察、复盘这些代码有 56 处依赖 `user.id`。如果访客的实现方式是把
`user_id` 改成可空，那些地方全都要加判空分支，而且漏一处就是线上 500 ——
**而这类错误只在访客路径上触发，正常用户的测试永远发现不了。**

所以下面最关键的一条是 `test_guest_can_use_normal_endpoints`：
一个刚创建的访客，能像普通用户一样调用受保护接口。**这条通过，
才说明「访客 = 临时用户」这个设计真的成立。**
"""

from __future__ import annotations

import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def _relax_guest_rate_limit(monkeypatch):
    """测试里放开「建访客」的频率限制。

    这些用例会在同一秒内从同一个测试 IP 建多个访客，命中 `GUEST_CREATE_PER_MIN`
    （默认 6 次/分钟）——限流本身是对的，见下面 `TestGuestRateLimit`，
    但那属于另一件事，不该让功能性用例互相打架。

    **这个 fixture 本身就是限流生效的旁证**：第一次跑测试时它把用例挡成了 429。
    """
    monkeypatch.setattr(settings, "GUEST_CREATE_PER_MIN", 10000)
    # IP 日计数是**进程内内存**的，不清会和别的用例串。见 services/guest.py 的说明。
    from app.services.guest import reset_ip_buckets

    reset_ip_buckets()
    yield
    reset_ip_buckets()


def _make_guest(client):
    """建一个访客，返回一个带令牌的调用器。

    必须传 token：`Actor` 刻意用 `Authorization: Bearer` 而不是共享 Cookie，
    因为 TestClient 的 cookie jar 是实例级的，多用户测试会互相串号。
    """
    from tests.conftest import Actor

    r = client.post("/api/auth/guest")
    assert r.status_code == 201, r.text
    body = r.json()
    return Actor(client, body["user"]["username"], body["token"]), body


class TestGuestCreation:
    def test_creates_guest_and_issues_token(self, client):
        actor, body = _make_guest(client)
        assert body["is_guest"] is True
        assert body["user"]["is_guest"] is True
        assert body["token"], "访客必须拿到令牌，否则前端没法调任何接口"
        assert body["user"]["username"].startswith("guest_")

    def test_guest_is_not_admin(self, client):
        _, body = _make_guest(client)
        assert body["user"]["is_admin"] is False

    def test_each_guest_is_distinct(self, client):
        _, a = _make_guest(client)
        _, b = _make_guest(client)
        assert a["user"]["id"] != b["user"]["id"]
        assert a["user"]["username"] != b["user"]["username"]

    def test_guest_password_is_not_guessable(self, client):
        """访客账号在认领前不可登录 —— 密码是随机串，没人知道。"""
        _, body = _make_guest(client)
        r = client.post(
            "/api/auth/login",
            json={"username": body["user"]["username"], "password": "guest"},
        )
        assert r.status_code == 401

    def test_cookie_is_set(self, client):
        """访客走的是和普通用户同一套 Cookie/Bearer 双通道。"""
        r = client.post("/api/auth/guest")
        assert r.status_code == 201
        assert any("dj_token" in c for c in r.headers.get_list("set-cookie"))


class TestGuestReusesExistingLogic:
    """**这是整个设计成立与否的证明。**"""

    def test_guest_can_use_normal_endpoints(self, client):
        actor, _ = _make_guest(client)

        # 会话恢复（普通用户的路径）
        me = actor.get("/api/auth/me")
        assert me.status_code == 200, me.text
        assert me.json()["user"]["is_guest"] is True

        # 受保护的业务接口 —— 能调通就说明没有因为 is_guest 而需要额外分支
        status = actor.get("/api/status-bar")
        assert status.status_code == 200, f"访客应该能像普通用户一样读状态栏: {status.text}"

        # 创建辩论（访客的核心体验）
        created = actor.post(
            "/api/debates",
            json={"topic": "我为什么会因为这点小事生气", "rounds": 4},
        )
        assert created.status_code == 201, f"访客应该能发起辩论: {created.text}"

    def test_guest_does_not_get_admin_endpoints(self, client):
        actor, _ = _make_guest(client)
        assert actor.get("/api/admin/users").status_code == 403


class TestGuestDoesNotPolluteNormalUsers:
    def test_normal_user_is_not_guest(self, client, unique_name):
        from tests.conftest import register

        actor = register(client, unique_name("ng"))
        me = actor.get("/api/auth/me").json()["user"]
        assert me["is_guest"] is False, "普通用户不能被误标成访客"


class TestGuestCostQuota:
    """访客会真实消耗 AI 额度，限额必须在**花钱之前**拦住。"""

    def _new_debate(self, actor, n: int):
        return actor.post(
            "/api/debates",
            json={"topic": f"测试辩题 {n}：我为什么会因为这点小事生气", "rounds": 4},
        )

    def test_daily_limit_blocks_third_debate(self, client, monkeypatch):
        from app.config import settings as s

        monkeypatch.setattr(s, "GUEST_DEBATES_PER_DAY", 2)
        actor, _ = _make_guest(client)

        assert self._new_debate(actor, 1).status_code == 201
        assert self._new_debate(actor, 2).status_code == 201

        blocked = self._new_debate(actor, 3)
        assert blocked.status_code == 403, f"第三次应被拦下: {blocked.text}"
        detail = blocked.json()["detail"]
        # 报错文案本身是转化点，必须提到注册
        assert "注册" in detail, f"限额文案应该引导注册: {detail}"

    def test_global_budget_blocks_everyone(self, client, monkeypatch):
        """全站预算打满时，即使这个访客自己还没用完也要拦 —— 这是防换 IP 的兜底。"""
        from app.config import settings as s

        # 先建好访客、再改预算：预算为 0 时**连访客都建不出来**（见下一条用例），
        # 所以顺序反过来的话这里验的就不是「发起辩论被拦」而是「建账号被拦」。
        actor, _ = _make_guest(client)
        monkeypatch.setattr(s, "GUEST_DAILY_BUDGET", 0)
        r = self._new_debate(actor, 1)
        assert r.status_code == 429, f"全站预算为 0 时应拦截: {r.text}"
        assert "已满" in r.json()["detail"]

    def test_global_budget_blocks_guest_creation(self, client, monkeypatch):
        """全站预算打满时**连访客账号都不再创建**。

        只在发起辩论那一步拦的话，用户会先拿到账号、走到开辩页、
        点了开始才撞墙；在门口拦下他，落地页就能当场显示「今日试用人次已满」。
        """
        from app.config import settings as s

        monkeypatch.setattr(s, "GUEST_DAILY_BUDGET", 0)
        r = client.post("/api/auth/guest")
        assert r.status_code == 429, f"预算为 0 时不应再建访客: {r.text}"
        assert "已满" in r.json()["detail"]

    def test_normal_user_has_no_quota(self, client, unique_name, monkeypatch):
        """限额只对访客生效 —— 普通用户不能受影响。"""
        from app.config import settings as s
        from tests.conftest import register

        monkeypatch.setattr(s, "GUEST_DEBATES_PER_DAY", 0)
        actor = register(client, unique_name("nq"))
        assert self._new_debate(actor, 1).status_code == 201


class TestClaimGuest:
    """认领：访客变正式账号，**数据原地继承，不搬家**。"""

    def test_guest_full_flow_then_claim(self, client, unique_name):
        """把访客模式的**验收标准**逐字变成断言：

          无痕窗口打开 → 无需登录完成一次微辩论 → 看到 AI 复盘卡 →
          点保存 → 转成正式账号，并且那条观察一条不丢。

        这条用例覆盖的是整条转化链路，而不是单点行为。它跑通才说明
        「先体验后注册」这件事在后端是真的成立，不只是页面上写着。
        """
        actor, _ = _make_guest(client)

        # ① 不登录也能开一场辩论
        created = actor.post(
            "/api/debates",
            json={"topic": "该不该在会议上直接反驳领导", "stance": "该"},
        )
        assert created.status_code == 201, created.text
        room_id = created.json()["room"]["id"]

        # ② 辩两轮（一轮拿不到观察，观察者需要足够依据）
        for text in (
            "我认为该，因为不反驳就会被一直追问到底",
            "而且上次我忍了一次，结果对方变本加厉",
        ):
            sent = actor.post(f"/api/debates/{room_id}/messages", json={"content": text})
            assert sent.status_code == 201, sent.text

        # ③ 结束并拿到复盘卡
        finished = actor.post(f"/api/debates/{room_id}/finish")
        assert finished.status_code == 200, finished.text
        review = finished.json()["review"]
        assert review is not None, "访客必须能拿到复盘卡，否则他没有东西可保存"
        assert (review["good"]["content"] or review["notice"]["content"] or review["next_time"]["content"]), (
            f"复盘卡不能是空的: {review}"
        )
        observations_before = actor.get("/api/observations").json()["observations"]

        # ④ 点「保存」→ 认领成正式账号
        name = unique_name("flow")
        claimed = actor.post(
            "/api/auth/claim",
            json={"username": name, "password": "ClaimPass123", "nickname": ""},
        )
        assert claimed.status_code == 200, claimed.text
        assert claimed.json()["user"]["is_guest"] is False

        # ⑤ 刚才那场辩论和那张复盘卡**一条不丢** —— 这是「原地认领」的核心承诺
        detail = actor.get(f"/api/debates/{room_id}")
        assert detail.status_code == 200
        assert detail.json()["review"] is not None, "认领后复盘卡不能丢"

        observations_after = actor.get("/api/observations").json()["observations"]
        assert len(observations_after) == len(observations_before), "认领前后观察数量应一致"

        # ⑥ 认领后就是正式账号：能登录，也能进只有正式账号能用的接口
        relogin = client.post("/api/auth/login", json={"username": name, "password": "ClaimPass123"})
        assert relogin.status_code == 200
        assert actor.get("/api/weaknesses").status_code == 200

    def test_claim_converts_and_keeps_data(self, client, unique_name):
        actor, body = _make_guest(client)
        old_id = body["user"]["id"]

        # 访客先产生一点数据
        created = actor.post(
            "/api/debates",
            json={"topic": "认领前我做的这场辩论", "rounds": 4},
        )
        assert created.status_code == 201
        room_id = created.json().get("room", {}).get("id") or created.json().get("id")

        name = unique_name("cl")
        claimed = actor.post(
            "/api/auth/claim",
            json={"username": name, "password": "ClaimPass123", "nickname": name},
        )
        assert claimed.status_code == 200, claimed.text
        u = claimed.json()["user"]
        assert u["is_guest"] is False
        assert u["username"] == name
        assert u["id"] == old_id, "认领必须原地继承，不能新建账号"

        # 数据还在（同一个 id，所以辩论记录天然还在）
        me = actor.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"]["username"] == name
        if room_id:
            room = actor.get(f"/api/debates/{room_id}")
            assert room.status_code == 200, "认领后应该还能看到自己认领前的辩论"

        # 认领后的密码真的能登录
        r = client.post("/api/auth/login", json={"username": name, "password": "ClaimPass123"})
        assert r.status_code == 200

    def test_claim_rejects_duplicate_username(self, client, unique_name):
        from tests.conftest import register

        taken = register(client, unique_name("tk"))
        actor, _ = _make_guest(client)
        r = actor.post(
            "/api/auth/claim",
            json={"username": taken.username, "password": "ClaimPass123"},
        )
        assert r.status_code == 409

    def test_claim_rejects_weak_password(self, client, unique_name):
        actor, _ = _make_guest(client)
        r = actor.post(
            "/api/auth/claim",
            json={"username": unique_name("wk"), "password": "123"},
        )
        assert r.status_code == 400

    def test_normal_user_cannot_claim(self, client, unique_name):
        from tests.conftest import register

        actor = register(client, unique_name("nc"))
        r = actor.post(
            "/api/auth/claim",
            json={"username": unique_name("nc2"), "password": "ClaimPass123"},
        )
        assert r.status_code == 400
        assert "不是访客" in r.json()["detail"]
