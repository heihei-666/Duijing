"""对镜 · 修改密码与管理员重置

【为什么这两件事要一起做】

这个项目**没有邮件也没有短信**，用户忘了密码就没人能帮 —— 之前只能由开发者
手工改库。那不是功能，是运维事故的日常。所以需要两条路：

  · `PATCH /api/account/password`  —— 自己改，**必须验当前密码**
  · `POST  /api/admin/users/{id}/reset-password` —— 管理员替别人重置，返回临时密码

分开的理由：管理员看不到别人的密码（库里只有 bcrypt 哈希），
所以对他而言「重置」是唯一可行的语义；而自己改密码必须证明「你是你」。
"""

from __future__ import annotations

from tests.conftest import register


def _login(client, username: str, password: str):
    return client.post("/api/auth/login", json={"username": username, "password": password})


class TestChangeOwnPassword:
    def test_requires_current_password(self, client, unique_name):
        """只看「已登录」不够 —— 一台忘记登出的设备被人拿到就能锁死账号。"""
        actor = register(client, unique_name("pw"))
        r = actor.patch(
            "/api/account/password",
            json={"current_password": "WrongOldPass1", "new_password": "BrandNewPass9"},
        )
        assert r.status_code == 400
        assert "当前密码" in r.json()["detail"]

        # 密码没被改掉：原密码仍可登录
        assert _login(client, actor.username, "TestPass123").status_code == 200

    def test_rejects_weak_new_password(self, client, unique_name):
        actor = register(client, unique_name("pw"))

        # 太短 / 纯数字 → 被 validate_password_strength 拒绝（400）
        for bad in ("short1", "12345678"):
            r = actor.patch(
                "/api/account/password",
                json={"current_password": "TestPass123", "new_password": bad},
            )
            assert r.status_code == 400, f"{bad!r} 应被 400 拒绝，实际 {r.status_code}"

        # 超长 → 被 Pydantic 的 max_length=128 挡在更外层（422）
        # 两道防线都在，只是返回码不同；这里如实断言各自的边界。
        r = actor.patch(
            "/api/account/password",
            json={"current_password": "TestPass123", "new_password": "a" * 200},
        )
        assert r.status_code == 422, f"超长密码应在字段校验层被挡，实际 {r.status_code}"

    def test_rejects_same_as_current(self, client, unique_name):
        actor = register(client, unique_name("pw"))
        r = actor.patch(
            "/api/account/password",
            json={"current_password": "TestPass123", "new_password": "TestPass123"},
        )
        assert r.status_code == 400
        assert "相同" in r.json()["detail"]

    def test_change_then_login_with_new(self, client, unique_name):
        actor = register(client, unique_name("pw"))
        r = actor.patch(
            "/api/account/password",
            json={"current_password": "TestPass123", "new_password": "BrandNewPass9"},
        )
        assert r.status_code == 200, r.text

        assert _login(client, actor.username, "BrandNewPass9").status_code == 200
        assert _login(client, actor.username, "TestPass123").status_code == 401

    def test_requires_login(self, client):
        """未登录应 401。

        ⚠️ 必须先清 cookie：`client` fixture 是**会话级**的，
        它的 cookie jar 会带着前面用例的登录态 —— 不清就会「被当成已登录、
        只是当前密码不对」，返回 400 而不是 401。
        （这个坑我踩过一次，所以在这里写明。）
        """
        client.cookies.clear()
        r = client.patch(
            "/api/account/password",
            json={"current_password": "x", "new_password": "y"},
        )
        assert r.status_code == 401


class TestAdminUserList:
    def test_only_admin(self, client, unique_name):
        actor = register(client, unique_name("nu"))
        assert actor.get("/api/admin/users").status_code == 403

    def test_never_returns_password_hash(self, client, unique_name):
        """**这条最重要**：即使调用者是管理员，哈希也不该离开数据库。"""
        admin = register(client, unique_name("ad"))
        # 让这个账号成为管理员：conftest 的引导账号才是管理员，
        # 这里直接改库更贴近真实（第一个注册的用户自动是管理员）
        import asyncio

        from sqlalchemy import select

        from app.db import session_scope
        from app.models import User

        async def promote() -> None:
            async with session_scope() as s:
                u = await s.scalar(select(User).where(User.username == admin.username))
                assert u is not None
                u.is_admin = True

        asyncio.run(promote())

        r = admin.get("/api/admin/users")
        assert r.status_code == 200, r.text
        users = r.json()["users"]
        assert users, "用户列表不该为空"

        for item in users:
            assert "password_hash" not in item, f"泄漏了哈希字段：{item}"
            assert set(item) == {
                "id",
                "username",
                "nickname",
                "is_admin",
                "created_at",
                "deletion_requested_at",
            }, f"字段集变了：{set(item)}"

        # 整体序列化后再扫一遍，防止嵌套里混进去
        assert "password_hash" not in r.text
        assert "$2b$" not in r.text, "响应里出现了 bcrypt 哈希前缀"


class TestAdminReset:
    def _make_admin(self, client, actor):
        import asyncio

        from sqlalchemy import select

        from app.db import session_scope
        from app.models import User

        async def promote() -> None:
            async with session_scope() as s:
                u = await s.scalar(select(User).where(User.username == actor.username))
                assert u is not None
                u.is_admin = True

        asyncio.run(promote())

    def test_only_admin(self, client, unique_name):
        actor = register(client, unique_name("nu2"))
        victim = register(client, unique_name("vv2"))
        r = actor.post(f"/api/admin/users/{1}/reset-password")
        assert r.status_code == 403

    def test_reset_returns_usable_temp_password(self, client, unique_name):
        admin = register(client, unique_name("ad2"))
        target = register(client, unique_name("tg2"))
        self._make_admin(client, admin)

        # 先拿到目标用户 id
        users = admin.get("/api/admin/users").json()["users"]
        tid = next(u["id"] for u in users if u["username"] == target.username)

        r = admin.post(f"/api/admin/users/{tid}/reset-password")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["username"] == target.username
        assert body["is_self"] is False
        temp = body["temp_password"]
        assert temp and len(temp) >= 8
        # 响应里绝不能出现哈希
        assert "$2b$" not in r.text

        # 临时密码真的能登录，旧密码失效
        assert _login(client, target.username, temp).status_code == 200
        assert _login(client, target.username, "TestPass123").status_code == 401

    def test_unknown_user(self, client, unique_name):
        admin = register(client, unique_name("ad3"))
        self._make_admin(client, admin)
        assert admin.post("/api/admin/users/999999/reset-password").status_code == 404

    def test_temp_password_has_no_ambiguous_chars(self):
        """临时密码大概率要靠人念或手输，不能含 0/O、1/l/I。"""
        import re

        from app.api.admin import _temp_password

        for _ in range(20):
            pw = _temp_password()
            assert not re.search(r"[0O1lI]", pw), f"含易混字符：{pw}"
            assert len(pw) >= 8


class TestIsAdminExposed:
    """`/api/auth/me` 等接口要返回 `is_admin`（本人自己的标志）。

    前端靠它决定要不要渲染管理区块。没有这个字段，界面只能靠
    「先请求、拿到 403 再隐藏」来猜 —— 那会在管理员每次进设置页时
    都打一次注定失败的请求，而且非管理员会看到一闪而过的空区块。
    """

    def test_me_includes_is_admin(self, client, unique_name):
        actor = register(client, unique_name("ia"))
        body = actor.get("/api/auth/me").json()
        assert "is_admin" in body["user"], f"缺少 is_admin：{body['user']}"
        # conftest 的引导账号才是管理员，普通注册用户不是
        assert body["user"]["is_admin"] is False

    def test_login_includes_is_admin(self, client, unique_name):
        actor = register(client, unique_name("ib"))
        r = client.post(
            "/api/auth/login",
            json={"username": actor.username, "password": "TestPass123"},
        )
        assert r.status_code == 200
        assert "is_admin" in r.json()["user"]

    def test_admin_sees_true(self, client, unique_name):
        """真正的管理员必须拿到 true —— 否则他自己的设置页里没有管理区块。"""
        import asyncio

        from sqlalchemy import select

        from app.db import session_scope
        from app.models import User

        actor = register(client, unique_name("ic"))

        async def promote() -> None:
            async with session_scope() as s:
                u = await s.scalar(select(User).where(User.username == actor.username))
                assert u is not None
                u.is_admin = True

        asyncio.run(promote())

        assert actor.get("/api/auth/me").json()["user"]["is_admin"] is True
