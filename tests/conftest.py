"""对镜 · 测试夹具

关键：必须在导入 app 之前把环境变量设好。
app.config 里的 Settings 是在模块导入时实例化的，
之后再改 os.environ 不会生效（尤其是 DB_PATH 与 JWT_SECRET）。
"""

from __future__ import annotations

import itertools
import os
import tempfile

# ── 先设环境，再导入应用 ──────────────────────────────────────
_TMP_DIR = tempfile.mkdtemp(prefix="duijing-test-")

os.environ["DB_PATH"] = os.path.join(_TMP_DIR, "test.db")
os.environ["ENABLE_SCHEDULER"] = "false"
os.environ["AI_PROVIDER"] = "mock"
os.environ["JWT_SECRET"] = "test-secret-not-for-production-use-only"
os.environ["COOKIE_SECURE"] = "false"
os.environ["ENV"] = "test"
os.environ["BOOTSTRAP_INVITE_CODE"] = ""

# 放宽限流阈值。
# 用例数量远超生产阈值（一分钟内注册几十个账号），不放开的话
# 几乎每个用例都会撞 429——但那是限流器在正确工作，不是缺陷。
# 限流器本身的行为由 TestRateLimiter 单独验证。
os.environ["LOGIN_RATE_PER_MIN"] = "100000"
os.environ["DEBATE_RATE_PER_MIN"] = "100000"
os.environ["AI_RATE_PER_MIN"] = "100000"
os.environ["LOGIN_LOCK_THRESHOLD"] = "100000"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.ai.mock import MockProvider  # noqa: E402
from app.db import Base, engine  # noqa: E402

# 全局自增序号：用户名必须跨用例唯一（共用一个数据库）
_NAME_SEQ = itertools.count()


@pytest.fixture(scope="session", autouse=True)
def _fast_mock_stream():
    """测试里不要模拟打字延迟，否则整套用例要跑几分钟。"""
    MockProvider.stream_delay = 0
    yield


@pytest.fixture(scope="session")
def client():
    """整个测试会话共用一个 TestClient（也就共用同一个 lifespan 与数据库）。"""
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


# 引导管理员的邀请码。所有测试用户都靠它注册。
#
# 为什么需要它：产品规则是「只有第一个用户能免邀请码注册，之后必须凭邀请码」。
# 测试共用一个数据库，如果不先把第一个用户建出来，
# 第一个执行的用例会意外成为系统管理员，而后续用例全部撞 400。
_BOOTSTRAP: dict[str, str] = {}


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_admin(client):
    """在任何用例之前建好引导账号，并记下它的邀请码。"""
    response = client.post(
        "/api/auth/register",
        json={
            "username": "bootstrap_admin",
            "password": "BootstrapPass123",
            "nickname": "引导管理员",
        },
    )
    assert response.status_code == 201, f"引导账号创建失败：{response.text}"
    payload = response.json()
    _BOOTSTRAP["invite"] = payload["invite_code"]
    _BOOTSTRAP["token"] = payload["token"]

    # 清掉引导账号留下的 Cookie，否则后续「未登录应被拒绝」的用例会误判为已登录
    client.cookies.clear()

    yield
    _BOOTSTRAP.clear()


@pytest.fixture
def unique_name():
    """生成跨用例不冲突的用户名。

    注意计数器必须在 fixture 外部——放在 fixture 内部的话，
    function scope 会让它每个用例都重置，同名用户会撞 409。
    """

    def _make(prefix: str) -> str:
        return f"{prefix}{next(_NAME_SEQ)}x{os.getpid() % 1000}"

    return _make


@pytest.fixture(scope="session", autouse=True)
def _clean_db():
    yield
    import asyncio

    async def _drop():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)

    try:
        asyncio.run(_drop())
    except Exception:
        pass


# ── 便捷工具 ──────────────────────────────────────────────────


class Actor:
    """一个已登录的测试用户。

    刻意用 Authorization: Bearer 而不是共享 Cookie——
    TestClient 的 cookie jar 是实例级的，多用户测试会互相串号。
    """

    def __init__(self, client: TestClient, username: str, token: str = "") -> None:
        self.client = client
        self.username = username
        self.token = token

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def get(self, url: str, **kw):
        kw.setdefault("headers", self._headers)
        return self.client.get(url, **kw)

    def post(self, url: str, **kw):
        kw.setdefault("headers", self._headers)
        return self.client.post(url, **kw)

    def patch(self, url: str, **kw):
        kw.setdefault("headers", self._headers)
        return self.client.patch(url, **kw)


def register(client: TestClient, username: str, invite_code: str | None = None) -> Actor:
    """注册并拿到令牌。

    默认使用引导管理员签发的邀请码——产品只允许第一个用户免码注册，
    测试必须遵守同一条规则，不能靠后门绕过。
    """
    if invite_code is None:
        invite_code = _BOOTSTRAP.get("invite", "")

    response = client.post(
        "/api/auth/register",
        json={
            "username": username,
            "password": "TestPass123",
            "nickname": username,
            "invite_code": invite_code,
        },
    )
    assert response.status_code == 201, response.text

    # 注册接口会下发 httpOnly Cookie，而 TestClient 的 cookie jar 是实例级的。
    # 不清掉的话，下一个"未登录"请求会带着上一个用户的 Cookie 通过认证，
    # 多用户测试也会互相串号。清干净，让每个 Actor 只靠自己的 Bearer 令牌。
    client.cookies.clear()

    return Actor(client, username, response.json()["token"])


def make_weakness(actor: Actor, name: str = "被追问时防御性重复") -> dict:
    response = actor.post(
        "/api/weaknesses",
        json={
            "name": name,
            "description": "被连续追问时会重复原话，不补充新证据",
            "domains": ["work", "expression"],
            "confidence": 4,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["weakness"]


def make_loop(actor: Actor, weakness_id: int, *, activate: bool = True) -> dict:
    response = actor.post(
        f"/api/weaknesses/{weakness_id}/loops",
        json={
            "mode": "form",
            "trigger_scene": "开会被追问进度",
            "body_signal": "心跳加快，想立刻反驳",
            "action_plan": "先说这点我还没想清楚，再补一条事实",
            "activate": activate,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["loop"]
