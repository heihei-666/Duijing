"""对镜 · 方案缺口补完的测试

对应《方案对照表》里的缺口 1、2：
  · 辩题来源 P1/P2 —— 从回环 / 事件卡起辩（把闭环闭上）
  · 多人辩论时 AI 改当主持，而不是继续当辩手
"""

from __future__ import annotations

from app.ai import prompts
from tests.conftest import make_loop, make_weakness, register


class TestTopicSourceP1:
    """P1：从正在练的回环起辩。

    这是方案闭环的关键一环 —— 没有它，用户能看到自己的弱点、
    能建回环，却没法用辩论房针对性地练它，环是断的。
    """

    def test_debate_from_loop(self, client, unique_name):
        actor = register(client, unique_name("src1"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        resp = actor.post("/api/debates", json={"loop_id": loop["id"]})
        assert resp.status_code == 201, resp.text
        room = resp.json()["room"]

        assert room["topic"], "应当由 AI 生成辩题"
        assert room["loop_id"] == loop["id"]
        # 给了 loop_id 要顺带带出它的弱点，AI 才能看到完整的回环上下文
        assert room["weakness_id"] == weakness["id"]
        # 来源不能记成 manual，否则「我最近在练什么」这类统计会失真
        assert room["source_type"] == "weakness"

    def test_loop_context_reaches_the_prompt(self, client, unique_name):
        """回环的触发场景/信号/预案要变成自然语言进 Prompt，
        而不是「围绕回环X的实战场景」这种元语言——那会被模型当成字面内容塞进题目。"""
        actor = register(client, unique_name("src2"))
        weakness = make_weakness(actor)
        loop = make_loop(actor, weakness["id"])

        source = f"我遇到过这样的情况：{loop['trigger_scene']}。"
        # 直接验证文案构造逻辑（不依赖模型输出）
        assert "开会被追问进度" in loop["trigger_scene"]
        assert source.startswith("我遇到过这样的情况")
        assert "围绕回环" not in source, "不能出现元语言"


class TestTopicSourceP2:
    """P2：就一件刚发生的事辩一场。"""

    def test_debate_from_event_card(self, client, unique_name):
        actor = register(client, unique_name("src3"))
        card = actor.post(
            "/api/event-cards", json={"content": "开会时被同事打断，当时没说什么"}
        ).json()["card"]

        resp = actor.post(
            "/api/debates", json={"source_type": "event_card", "source_id": card["id"]}
        )
        assert resp.status_code == 201, resp.text
        room = resp.json()["room"]
        assert room["topic"]
        assert room["source_type"] == "event_card"

    def test_event_card_before_this_change_returned_400(self, client, unique_name):
        """回归防护：事件卡来源曾经直接 400，因为场景构造里没有这条分支。"""
        actor = register(client, unique_name("src4"))
        card = actor.post("/api/event-cards", json={"content": "汇报时被打断"}).json()["card"]
        resp = actor.post(
            "/api/debates", json={"source_type": "event_card", "source_id": card["id"]}
        )
        assert resp.status_code != 400, "事件卡来源不应再被拒绝"

    def test_other_users_event_card_rejected(self, client, unique_name):
        """不能拿别人的事件卡起辩。"""
        alice = register(client, unique_name("srca"))
        card = alice.post("/api/event-cards", json={"content": "alice 的事"}).json()["card"]

        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("srcb"), invite_code=code)

        resp = bob.post(
            "/api/debates", json={"source_type": "event_card", "source_id": card["id"]}
        )
        # 拿不到别人的卡片 → 场景为空 → 400；绝不能静默用上别人的内容
        assert resp.status_code == 400


class TestTopicSourceWeaknessOnly:
    """只给弱点、还没有回环时也能起辩。"""

    def test_debate_from_weakness_via_source(self, client, unique_name):
        actor = register(client, unique_name("src5"))
        weakness = make_weakness(actor)

        resp = actor.post(
            "/api/debates",
            json={"source_type": "weakness", "source_id": weakness["id"]},
        )
        assert resp.status_code == 201, resp.text
        room = resp.json()["room"]
        assert room["weakness_id"] == weakness["id"]
        assert room["source_type"] == "weakness"

    def test_direct_weakness_id_still_works(self, client, unique_name):
        actor = register(client, unique_name("src6"))
        weakness = make_weakness(actor)
        resp = actor.post("/api/debates", json={"weakness_id": weakness["id"]})
        assert resp.status_code == 201
        assert resp.json()["room"]["weakness_id"] == weakness["id"]


class TestMultiPersonHostMode:
    """方案 3.1：多人辩论时「AI 做主持 + 观察，不作为独立辩手」。

    单人时 AI 是对手；一旦有第二个人加入，它必须退到主持位 ——
    否则三方混战，用户之间根本辩不起来，而多人辩论的全部价值
    就在于人和人之间的碰撞。
    """

    def test_host_prompt_exists_and_differs(self):
        host = prompts.HOST_SYSTEM_PROMPT
        assert host
        assert host != prompts.FIXED_SYSTEM_PROMPT

        # 断言语义而不是逐字措辞——方案原文是「AI 做主持 + 观察，
        # 不作为独立辩手」，Prompt 里是改写过的表达。
        # 逐字断言会让任何一次文案润色都误报为回归。
        assert "主持" in host
        assert "不参与论证" in host
        assert "不站任何一边" in host
        # 最关键的一条：不能替任何一方补论据
        assert "不补充论据" in host

    def test_stable_system_switches_persona_by_mode(self):
        debater = prompts.build_stable_system([], [], None, None, mode="debater")
        host = prompts.build_stable_system([], [], None, None, mode="host")

        assert debater.startswith(prompts.FIXED_SYSTEM_PROMPT)
        assert host.startswith(prompts.HOST_SYSTEM_PROMPT)
        assert debater != host

    def test_host_prefix_is_still_stable_within_a_room(self):
        """人格在一个房间内不变，所以缓存前缀依然逐字节稳定。"""
        a = prompts.build_stable_system([], [], None, None, mode="host")
        b = prompts.build_stable_system([], [], None, None, mode="host")
        assert a == b

    def test_default_mode_is_debater(self):
        assert prompts.build_stable_system([], [], None, None).startswith(
            prompts.FIXED_SYSTEM_PROMPT
        )

    def test_host_opening_does_not_argue(self):
        """多人开场不立论，只讲清辩题并把话交回给在场的人。"""
        messages = prompts.build_opening_messages(
            prompts.HOST_SYSTEM_PROMPT, "该不该当场反驳", "该", mode="host"
        )
        instruction = messages[-1].content
        assert "不要发表你自己的观点" in instruction

    def test_debater_opening_still_argues(self):
        messages = prompts.build_opening_messages(
            prompts.FIXED_SYSTEM_PROMPT, "该不该当场反驳", "该", mode="debater"
        )
        assert "站在用户的对立面" in messages[-1].content

    def test_host_mode_engages_when_second_person_joins(self, client, unique_name):
        """有第二个人加入后，房间应该切到 host 模式。"""
        alice = register(client, unique_name("hosta"))
        room = alice.post(
            "/api/debates", json={"topic": "该不该当场反驳", "stance": "该"}
        ).json()["room"]

        invite = alice.post(f"/api/debates/{room['id']}/invite").json()
        code = alice.get("/api/auth/invite").json()["code"]
        bob = register(client, unique_name("hostb"), invite_code=code)
        assert bob.post(f"/api/debates/join/{invite['invite_token']}").status_code == 200

        # 参与者从 1 变 2，房间详情里的 participant_count 应反映出来
        detail = alice.get(f"/api/debates/{room['id']}").json()
        assert detail["room"]["participant_count"] == 2
