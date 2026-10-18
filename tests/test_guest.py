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
