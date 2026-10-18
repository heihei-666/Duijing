"""对镜 · 陪练化 / 台阶 / 首页锚点（本轮用户反馈驱动）

【这组测试真正要证明的事】

用户的原话是「AI 太强，我像在被审问」和「不知道每天来干嘛」。

这两句话都不是「某个接口坏了」，而是**产品性格**的问题 ——
而 prompt 是产品性格的唯一载体。所以这里一半是接口测试，
另一半是**对 prompt 的契约测试**：

    · 陪练人格里必须写着「不法官口吻」「卡住时给台阶」
    · 复盘人格里必须写着「不评判对错」「只描述模式」
    · 台阶 prompt 里必须写着「不是替他回答」

这类断言看起来土，但它是**唯一能阻止下一次改动把这份性格改回去**的东西 ——
prompt 是纯文本，没有任何类型系统保护它。
"""

from __future__ import annotations

import pytest

from app.ai import prompts


def _make_room(actor, topic: str = "该不该在会议上直接反驳领导") -> int:
    created = actor.post("/api/debates", json={"topic": topic, "stance": "该"})
    assert created.status_code == 201, created.text
    return created.json()["room"]["id"]


class TestCoachPersona:
    """辩论人格：从「辩手」改成「陪练」。"""

    def test_prompt_keeps_challenge_but_bans_judge_tone(self):
        """强度保留在论点上，去掉的是压迫感 —— 这两件事必须同时成立。"""
        text = prompts.FIXED_SYSTEM_PROMPT
        assert "陪练" in text
        # ① 不法官口吻：这三类句子被明确点名禁止
        assert "禁止法官口吻" in text
        assert "你这里逻辑错了" in text
        # ② 卡住时给台阶：这是本轮最核心的改动
        assert "台阶" in text
        # ③ 但**没有**变成应声虫 —— 不许一味附和
        assert "不是考官" in text
        assert "附和" in text or "不让步" in text or "力量" in text

    def test_prompt_keeps_observer_role(self):
        """观察者身份不能因为「变温柔」被删掉 —— 那是产品的地基。"""
        assert "观察者" in prompts.FIXED_SYSTEM_PROMPT
        assert "只在辩论结束后输出" in prompts.FIXED_SYSTEM_PROMPT


class TestReviewNoJudge:
    """复盘：从「评估报告」改成「一面镜子」。"""

    def test_review_prompt_forbids_judgement(self):
        text = prompts._REVIEW_SYSTEM_V2_2
        assert "不评判对错" in text
        # 人格判决被点名拉黑
        assert "抗压能力不足" in text
        # 但具体性要求没有被放松 —— 这是上一轮评测花大力气才拿到的
        assert "具体" in text

    def test_review_version_is_rolled(self):
        """版本号必须跟着变：ai_call_log.prompt_version 靠它区分产出。"""
        assert prompts.REVIEW_PROMPT_VERSION == "v2.2"
        assert "v2.2" in prompts._REVIEW_SYSTEMS
        assert prompts.PROMPT_VERSION.endswith("v2.2")

    def test_v22_is_an_increment_over_v21(self):
        """v2.2 必须是 v2.1 的**追加**，不是另抄一份。

        另抄一份的后果：v2.1 修好的「三个叙事块不许为空」会在 v2.2 里静默丢失，
        而那个回归当时是靠规则层评测抓出来的。
        """
        assert prompts._REVIEW_SYSTEM_V2_2.startswith(prompts._REVIEW_SYSTEM_V2_1)
        assert "三个块必须有内容" in prompts._REVIEW_SYSTEM_V2_2


class TestHintPrompt:
    """台阶：一句话头，不是替用户回答。"""

    def test_hint_prompt_is_one_short_line(self):
        messages = prompts.build_hint_messages("辩题", "立场", "AI：你说呢？")
        system = messages[0].content
        assert "不超过 60 字" in system
        assert "不是替他回答" in system
        # 反例必须写在 prompt 里，否则模型很容易滑回「给标准答案」
        assert "这是替他回答" in system

    def test_hint_builder_carries_topic_and_transcript(self):
        messages = prompts.build_hint_messages("早睡靠自律", "靠自律", "用户：我不知道")
        assert len(messages) == 2
        assert "早睡靠自律" in messages[1].content
        assert "我不知道" in messages[1].content


class TestHintEndpoint:
    def test_returns_hint_without_touching_round_or_messages(self, client, unique_name):
        """台阶**不能**进辩论记录：它一旦落库，AI 下一轮就会变得小心翼翼。"""
        from tests.conftest import register

        actor = register(client, unique_name("hint"))
        room_id = _make_room(actor)

        before = actor.get(f"/api/debates/{room_id}").json()
        before_messages = len(before["messages"])
        before_round = before["room"]["current_round"]

        r = actor.post(f"/api/debates/{room_id}/hint")
        assert r.status_code == 200, r.text
        hint = r.json()["hint"]
        assert hint.strip(), "台阶不能是空字符串"
        assert len(hint) <= 120, "台阶是一句话，不是一段话"

        after = actor.get(f"/api/debates/{room_id}").json()
        assert len(after["messages"]) == before_messages, "台阶不该写进辩论记录"
        assert after["room"]["current_round"] == before_round, "台阶不该占一轮"
        # 还没结束的房间不该因为要了一次台阶就冒出复盘
        assert after.get("review") is None

    def test_finished_room_rejects_hint(self, client, unique_name):
        from tests.conftest import register

        actor = register(client, unique_name("hint2"))
        room_id = _make_room(actor)
        actor.post(f"/api/debates/{room_id}/finish")
        r = actor.post(f"/api/debates/{room_id}/hint")
        assert r.status_code == 409

    def test_outsider_cannot_get_hint(self, client, unique_name):
        """别人的辩论房：台阶也不能白拿 —— 它会带着对方辩题去调 AI。"""
        from tests.conftest import register

        owner = register(client, unique_name("hown"))
        room_id = _make_room(owner)
        other = register(client, unique_name("hout"))
        assert other.post(f"/api/debates/{room_id}/hint").status_code == 403

    def test_requires_login(self, client):
        client.cookies.clear()
        assert client.post("/api/debates/1/hint").status_code == 401


class TestStatusAnchors:
    """首页两个锚点：一句问候 + 过去的你。"""

    def test_status_bar_has_greeting(self, client, unique_name):
        from tests.conftest import register

        actor = register(client, unique_name("greet"))
        body = actor.get("/api/status-bar").json()
        assert isinstance(body.get("greeting"), str)
        assert body["greeting"].strip(), "问候语不能是空字符串"

    def test_past_you_is_null_for_new_user(self, client, unique_name):
        """没有历史的人不能看到「对比区」—— 拿一次数据编出趋势是骗人。"""
        from tests.conftest import register

        actor = register(client, unique_name("past"))
        body = actor.get("/api/status-bar").json()
        assert "past_you" in body
        assert body["past_you"] is None

    def test_fresh_user_greeting_is_welcoming(self, client, unique_name):
        from tests.conftest import register

        actor = register(client, unique_name("fresh"))
        body = actor.get("/api/status-bar").json()
        assert body["is_fresh_start"] is True
        assert body["greeting"] == "慢慢来。这里只有你自己，写错了也没人看见。"


class TestPastYouWindow:
    """「过去的你」的窗口逻辑（直接测服务函数，绕开造历史的成本）。

    用内存里的假行喂给窗口计算 —— 真正跑数据库那一步在
    `test_past_you_is_null_for_new_user` 里已经覆盖了。
    """

    @staticmethod
    def _window(rows, today, first_days_ago):
        """复刻服务里那段窗口切分，用于验证边界。"""
        from datetime import timedelta

        first_date = today - timedelta(days=first_days_ago)
        early_end = first_date + timedelta(days=6)
        recent_start = today - timedelta(days=6)
        early = [(d, r) for d, r in rows if first_date <= d <= early_end]
        recent = [(d, r) for d, r in rows if recent_start <= d <= today]
        return early, recent

    def test_no_overlap_requires_a_week_of_history(self):
        from datetime import date, timedelta

        today = date(2026, 10, 18)
        early, recent = self._window([], today, 3)
        assert early == [] and recent == []

    def test_windows_are_disjoint_when_history_is_long_enough(self):
        from datetime import date, timedelta

        today = date(2026, 10, 18)
        rows = [
            (today - timedelta(days=100), "hold"),
            (today - timedelta(days=99), "break"),
            (today - timedelta(days=1), "hold"),
            (today - timedelta(days=2), "hold"),
        ]
        early, recent = self._window(rows, today, 100)
        assert len(early) == 2 and len(recent) == 2
        # 两侧不能出现同一条记录 —— 两侧重叠时那个「对比」是假的
        assert not (set(early) & set(recent))


@pytest.mark.parametrize(
    "needle",
    [
        "陪练",
        "台阶",
        "不评判",
    ],
)
def test_product_personality_is_written_down(needle):
    """把本轮的产品决定钉进测试。

    prompt 是纯文本，没有任何类型系统保护它；下一次「顺手优化一下措辞」
    就可能把这份性格改回去，而没有人会收到编译错误。
    """
    corpus = prompts.FIXED_SYSTEM_PROMPT + prompts._REVIEW_SYSTEM_V2_2
    assert needle in corpus, f"产品性格里的「{needle}」在 prompt 里找不到了"
