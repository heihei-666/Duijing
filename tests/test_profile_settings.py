"""对镜 · 用户偏好（水平档位与通知开关）

这一组用例补的是一条**断掉的线**：

方案 3.1 要求「AI 风格根据用户水平调节（新手温和 / 中级正常 / 高级犀利）」。
提示词层真的实现了（`prompts._level_cn`），但在此之前：

  · `user_profile.level` 只在建档案时写默认值 `novice`，全仓库**没有第二处赋值**
  · 没有任何接口能改它（`api/account.py` 只有 export 和 deletion）
  · 前端 `web/src` 里搜 `level`：**0 个匹配**

净效果是**所有用户永远是「新手（温和，多给台阶）」**，这个档位是个够不着的开关。
`notify_debate_reminder` 与 `auto_scan_event_cards` 两列同样是死的
（只在导出数据时被读到，没有任何逻辑分支依赖它们）。

`PATCH /api/account/profile` 把这条线接上；本文件守住它真的接上了 ——
不只是「接口返回 200」，而是**档位确实传到了决定行为的代码里**。
"""

from __future__ import annotations

from tests.conftest import register


class TestProfileEndpoint:
    def test_defaults_to_novice(self, client, unique_name):
        actor = register(client, unique_name("prof0"))
        resp = actor.get("/api/account/profile")
        assert resp.status_code == 200, resp.text
        body = resp.json()["profile"]
        assert body["level"] == "novice"
        # 方案 3.9：通知默认关闭
        assert body["notify_debate_reminder"] is False
        # 方案 3.4：事件卡每周夜扫默认开启
        assert body["auto_scan_event_cards"] is True

    def test_patch_level_persists(self, client, unique_name):
        actor = register(client, unique_name("prof1"))

        patched = actor.patch("/api/account/profile", json={"level": "advanced"})
        assert patched.status_code == 200, patched.text
        assert patched.json()["profile"]["level"] == "advanced"

        # 重新读一次，确认是真落库而不是只改了返回值
        assert actor.get("/api/account/profile").json()["profile"]["level"] == "advanced"

    def test_invalid_level_rejected(self, client, unique_name):
        """档位只有三个取值；写错不该被静默吞掉。"""
        actor = register(client, unique_name("prof2"))
        resp = actor.patch("/api/account/profile", json={"level": "god-mode"})
        assert resp.status_code == 400
        # 值没被改动
        assert actor.get("/api/account/profile").json()["profile"]["level"] == "novice"

    def test_notification_toggles_persist(self, client, unique_name):
        actor = register(client, unique_name("prof3"))
        actor.patch(
            "/api/account/profile",
            json={"notify_debate_reminder": True, "auto_scan_event_cards": False},
        )
        body = actor.get("/api/account/profile").json()["profile"]
        assert body["notify_debate_reminder"] is True
        assert body["auto_scan_event_cards"] is False

    def test_partial_patch_leaves_other_fields_alone(self, client, unique_name):
        actor = register(client, unique_name("prof4"))
        actor.patch("/api/account/profile", json={"level": "intermediate"})
        actor.patch("/api/account/profile", json={"notify_debate_reminder": True})

        body = actor.get("/api/account/profile").json()["profile"]
        assert body["level"] == "intermediate", "只改通知开关不该把档位重置"
        assert body["notify_debate_reminder"] is True

    def test_requires_login(self, client):
        client.cookies.clear()
        assert client.get("/api/account/profile").status_code == 401
        assert client.patch("/api/account/profile", json={"level": "advanced"}).status_code == 401

    def test_is_per_user(self, client, unique_name):
        alice = register(client, unique_name("profA"))
        bob = register(client, unique_name("profB"))
        alice.patch("/api/account/profile", json={"level": "advanced"})

        assert alice.get("/api/account/profile").json()["profile"]["level"] == "advanced"
        assert bob.get("/api/account/profile").json()["profile"]["level"] == "novice"


class TestLevelActuallyChangesBehaviour:
    """**这是本文件最重要的用例。**

    接口返回 200 不等于那条线接上了 —— 断言必须落在「档位真的影响行为」上。
    `decide_max_rounds()` 会按档位加减 1 轮（app/services/debate.py:148-151），
    而 `max_rounds` 会出现在建房响应里，所以可以从外部观察到。
    """

    TOPIC = "该不该当场反驳"  # 7 个字，不触发「辩题较长 +1」，方便算准

    def test_advanced_user_gets_more_rounds_than_novice(self, client, unique_name):
        actor = register(client, unique_name("lvl"))

        # 默认 novice：5 - 1 = 4
        first = actor.post(
            "/api/debates", json={"topic": self.TOPIC, "stance": "该"}
        ).json()["room"]
        assert first["max_rounds"] == 4, "新手档应当是 4 轮"

        actor.patch("/api/account/profile", json={"level": "advanced"})

        # advanced：5 + 1 = 6
        second = actor.post(
            "/api/debates", json={"topic": self.TOPIC, "stance": "该"}
        ).json()["room"]
        assert second["max_rounds"] == 6, (
            "高级档应当是 6 轮 —— 如果还是 4，说明 profile.level 根本没被读取，"
            "「AI 风格按水平调节」依旧是个够不着的开关"
        )


class TestDependencyHygiene:
    """requirements.txt 是运行时的真实契约，写错不会报错、只会在别处炸。"""

    @staticmethod
    def _lines() -> list[str]:
        from pathlib import Path

        root = Path(__file__).resolve().parent.parent
        return [
            line.strip()
            for line in (root / "requirements.txt").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]

    def test_unused_python_dotenv_is_gone(self):
        """它曾经在依赖列表里，但全仓库没有一处 import（配置读取是 os.getenv）。"""
        assert not any(line.startswith("python-dotenv") for line in self._lines())

    def test_directly_imported_py_vapid_is_declared(self):
        """`app/services/push.py` 直接 import py_vapid，就不能只靠传递依赖。

        它目前确实由 pywebpush 带进来，但上游哪天去掉这条，
        我们就只会在运行时生成 VAPID 密钥那里才炸。
        """
        source = (self._root() / "app" / "services" / "push.py").read_text(encoding="utf-8")
        assert "import py_vapid" in source or "from py_vapid" in source, (
            "push.py 不再直接 import py_vapid 的话，这条测试本身要跟着改"
        )
        assert any(line.replace("_", "-").startswith("py-vapid") for line in self._lines())

    @staticmethod
    def _root():
        from pathlib import Path

        return Path(__file__).resolve().parent.parent
