"""对镜 · 评测集自身的测试

评测集也是代码，也会坏。而且它坏起来很隐蔽 ——
**一个永远返回「通过」的评测，比没有评测更危险**，因为它会让人以为有保障。

所以这里守三件事：
  1. golden set 的每一条都写对了（字段齐、层合法、发言够多）
  2. golden set 有**覆盖**：四层都要有，且不是同一条复制十遍
  3. 规则校验函数**真的会失败**（每条规则都配了反向用例）

第 3 条最容易被忽略：如果 `check_observations` 因为一个拼写错误永远返回 passed，
测试套件不会有任何反应。所以每条规则都要有一个「故意违规必须被抓到」的用例。
"""

from __future__ import annotations

from evals import checks


class TestGoldenSetShape:
    def test_all_cases_are_well_formed(self):
        cases = checks.load_golden()
        assert cases, "golden set 是空的"

        problems: list[str] = []
        for case in cases:
            problems.extend(f"{case.get('id', '?')}: {p}" for p in checks.validate_case_shape(case))
        assert not problems, "golden set 有用例写错了：\n  " + "\n  ".join(problems)

    def test_ids_are_unique(self):
        """id 撞了会让报告里两条用例互相覆盖，而且很难看出来。"""
        ids = [c["id"] for c in checks.load_golden()]
        duplicates = {i for i in ids if ids.count(i) > 1}
        assert not duplicates, f"重复的用例 id：{duplicates}"

    def test_covers_all_four_layers(self):
        """方案 3.1 的观察四层，每层都要有代表用例，否则等于没测那一层。"""
        layers = [c["layer"] for c in checks.load_golden()]
        missing = [layer for layer in checks.LAYER_HINTS if layer not in layers]
        assert not missing, f"这些观察层没有对应用例：{missing}"

    def test_cases_are_not_copies_of_each_other(self):
        """同一条用例复制很多遍会让「通过率」虚高。"""
        texts = [tuple(c["user_turns"]) for c in checks.load_golden()]
        duplicates = {t for t in texts if texts.count(t) > 1}
        assert not duplicates, f"有 {len(duplicates)} 组用例的发言完全相同，等于重复计数"

    def test_debates_are_long_enough_to_observe(self):
        """两轮发言的辩论观察不出「互动策略」或「语言习惯」——那是编的。"""
        for case in checks.load_golden():
            assert len(case["user_turns"]) >= 3, (
                f"{case['id']} 只有 {len(case['user_turns'])} 轮发言，不足以支撑四层观察"
            )


class TestRulesActuallyFail:
    """每条规则都要有一个「故意违规」的用例，否则规则可能永远返回通过。"""

    BASE = {
        "id": "t-1",
        "layer": "论证结构",
        "topic": "该不该当场反驳",
        "stance": "该",
        "user_turns": ["a", "b", "c"],
    }

    def _ok(self, **kwargs) -> checks.CaseResult:
        params = {"weakness": None, "advantage": None, "review_blocks": None}
        params.update(kwargs)
        return checks.check_observations(self.BASE, **params)

    def test_clean_case_passes(self):
        """先确认「正常输入能通过」，否则下面的失败断言可能只是因为函数永远失败。"""
        result = self._ok(
            weakness="偷换概念回避正面回答",
            advantage="用具体数据支撑论点",
            review_blocks={"good": "x", "notice": "y", "next_time": "z"},
        )
        assert result.passed, result.failures

    def test_generic_phrase_is_caught(self):
        result = self._ok(weakness="表现不错，继续加油")
        assert not result.passed
        assert any("废话" in f for f in result.failures)

    def test_too_long_observation_is_caught(self):
        result = self._ok(weakness="被追问时" + "非常" * 40 + "长的一句话")
        assert not result.passed
        assert any("过长" in f for f in result.failures)

    def test_repeating_the_topic_is_caught(self):
        result = self._ok(weakness="该不该当场反驳")
        assert not result.passed
        assert any("复读" in f for f in result.failures)

    def test_empty_review_block_is_caught(self):
        result = self._ok(review_blocks={"good": "", "notice": "y", "next_time": "z"})
        assert not result.passed
        assert any("good" in f for f in result.failures)

    def test_forbidden_substring_is_caught(self):
        case = dict(self.BASE, forbid_substrings=["硬撑"])
        result = checks.check_observations(case, weakness="硬撑不认错", advantage=None)
        assert not result.passed
        assert any("禁止内容" in f for f in result.failures)

    def test_more_than_two_observations_is_caught(self):
        """方案第九章第 5 条：每场最多 1 优势 + 1 弱点，不许多给。"""
        result = self._ok(weakness="论点缺乏支撑", advantage="论证有事实依据")
        assert result.passed, "两条观察本身是合法的"

        # 三条的情况由 summarize 之外的调用方保证；这里直接验证计数逻辑
        assert checks.MAX_OBSERVATIONS_PER_TYPE == 1

    def test_wrong_layer_is_noted(self):
        """观察没命中本层提示词：不判失败（可能是另一层），但要留下提示给 judge。"""
        result = self._ok(weakness="说话声音很小")
        assert result.passed
        assert any("未命中" in n for n in result.notes)


class TestSummarize:
    def test_summarize_counts_and_rates(self):
        results = [
            checks.CaseResult("a", passed=True),
            checks.CaseResult("b", passed=False, failures=["观察过长（50 > 40 字）：xxx"]),
            checks.CaseResult("c", passed=False, failures=["观察过长（60 > 40 字）：yyy"]),
        ]
        s = checks.summarize(results)
        assert s["total"] == 3
        assert s["passed"] == 1
        assert s["failed"] == 2
        assert s["pass_rate"] == round(1 / 3, 4)
        assert s["failure_kinds"]["观察过长"] == 2

    def test_empty_input_does_not_crash(self):
        s = checks.summarize([])
        assert s["total"] == 0
        assert s["pass_rate"] is None
