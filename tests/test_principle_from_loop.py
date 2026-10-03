"""对镜 · 「撑住率达标 → 原则候选」（方案的第二条核心数据流）

方案第 748-751 行把两条数据流定义为「这两条不断，系统就活着」：

    1. 辩论房/事件卡 → ai_observation → 弱点/优势 → 回环 → loop_log → 撑住率
    2. 回环撑住率达标 → principle 候选 → 原则启用 → 反向挂回环

第 2 条的**前三段此前是断的**：`PrincipleSource.LOOP_RATE` 从未被赋值、
`TASK_PRINCIPLE` 与 `build_principle_messages()` 写好了却零调用点、
全仓库只有「手动新建」与「辩论房结论」两个来源。

这个文件守住接上之后的四条性质：
  · 达标会产出候选，且置信度为 high（方案 3.6 的来源表里它是唯一高置信度）
  · **幂等** —— 同一个回环不会每记一次演练就多刷一条候选
  · 未达标不产出
  · **AI 失败不影响「记一笔」** —— 演练日志是用户的事实记录，原则只是附加产物
"""

from __future__ import annotations

from tests.conftest import make_loop, make_weakness, register

# 方案 3.3 / 3.6 的达标线：撑住率 ≥ 80% 且触发 ≥ 5
THRESHOLD_HOLDS = 5


def _log(actor, loop_id: int, result: str, note: str = ""):
    resp = actor.post(
        f"/api/loops/{loop_id}/logs", json={"result": result, "note": note}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _principle_candidates(actor) -> list[dict]:
    resp = actor.get("/api/principles")
    assert resp.status_code == 200, resp.text
    return resp.json()["principles"]


def _loop_rate_candidates(actor) -> list[dict]:
    return [p for p in _principle_candidates(actor) if p["source_type"] == "loop_rate"]


class TestPrincipleFromHoldRate:
    def test_candidate_is_created_when_threshold_reached(self, client, unique_name):
        actor = register(client, unique_name("plr"))
        card = make_weakness(actor, "我的弱点：被追问就防御")
        loop = make_loop(actor, card["id"])

        assert _loop_rate_candidates(actor) == [], "还没练就冒候选，说明触发条件写错了"

        for i in range(THRESHOLD_HOLDS):
            _log(actor, loop["id"], "hold", f"第 {i + 1} 次撑住")

        candidates = _loop_rate_candidates(actor)
        assert len(candidates) == 1, f"达标后应产出 1 条候选，实际 {len(candidates)}"

        candidate = candidates[0]
        assert candidate["status"] == "candidate", "应是候选，不能自动启用"
        assert candidate["confidence"] == "high", "方案 3.6：达标来源是唯一的高置信度"
        assert candidate["content"].strip(), "原则内容不能为空"
        # 方案第 751 行的「反向挂回环」
        assert candidate["linked_loop_ids"] == [loop["id"]]
        assert [lp["id"] for lp in candidate["linked_loops"]] == [loop["id"]]

    def test_candidate_is_idempotent(self, client, unique_name):
        """第 6、7 次继续撑住，不能每次都再刷一条 —— 否则原则库被同一个回环刷屏。"""
        actor = register(client, unique_name("plridem"))
        card = make_weakness(actor, "我的弱点：开会跑题")
        loop = make_loop(actor, card["id"])

        for _ in range(THRESHOLD_HOLDS):
            _log(actor, loop["id"], "hold")

        assert len(_loop_rate_candidates(actor)) == 1
        _log(actor, loop["id"], "hold")
        _log(actor, loop["id"], "hold")
        assert len(_loop_rate_candidates(actor)) == 1, "同一回环只应生成一次"

    def test_no_candidate_below_threshold(self, client, unique_name):
        """4 次撑住：撑住率 100%，但触发次数不够 5 —— 不达标。"""
        actor = register(client, unique_name("plrbelow"))
        card = make_weakness(actor, "我的弱点：怕否定")
        loop = make_loop(actor, card["id"])

        for _ in range(THRESHOLD_HOLDS - 1):
            _log(actor, loop["id"], "hold")

        assert _loop_rate_candidates(actor) == []

    def test_low_hold_rate_does_not_qualify(self, client, unique_name):
        """触发够了但撑住率只有 60%：也不该产出「练成了」的原则。"""
        actor = register(client, unique_name("plrlow"))
        card = make_weakness(actor, "我的弱点：急于下结论")
        loop = make_loop(actor, card["id"])

        for _ in range(3):
            _log(actor, loop["id"], "hold")
        for _ in range(2):
            _log(actor, loop["id"], "break")

        assert _loop_rate_candidates(actor) == []

    def test_ai_failure_does_not_break_recording(self, client, unique_name, monkeypatch):
        """原则提炼是后台附加产物；模型挂了也必须能正常记这一笔。"""
        from app.ai import structured
        from app.ai.base import AIError

        actor = register(client, unique_name("plrfail"))
        card = make_weakness(actor, "我的弱点：爱打断")
        loop = make_loop(actor, card["id"])

        async def boom(*args, **kwargs):
            raise AIError("模拟模型不可用")

        # 原则提炼走 app.ai.structured.complete_json，打桩要打在它用的那个名字上
        monkeypatch.setattr(structured, "complete", boom)

        for i in range(THRESHOLD_HOLDS):
            # 不能因为 AI 挂了就 500 —— 这条断言就是本用例的全部意义
            _log(actor, loop["id"], "hold", f"第 {i + 1} 次")

        # 演练日志确实都落库了
        logs = actor.get(f"/api/loops/{loop['id']}/logs").json()
        assert len(logs["logs"]) >= THRESHOLD_HOLDS
        # 但没有原则候选（提炼失败了）
        assert _loop_rate_candidates(actor) == []

    def test_degraded_suggestion_and_candidate_share_the_threshold(
        self, client, unique_name
    ):
        """降级提示与原则候选是同一条达标线的两个出口，应当同时出现。"""
        actor = register(client, unique_name("plrboth"))
        card = make_weakness(actor, "我的弱点：临场紧张")
        loop = make_loop(actor, card["id"])

        last = None
        for _ in range(THRESHOLD_HOLDS):
            last = _log(actor, loop["id"], "hold")

        assert last is not None
        assert last.get("hint") or last.get("suggest_downgrade") is not None, (
            "达标时应同时给出降级建议"
        )
        assert len(_loop_rate_candidates(actor)) == 1
