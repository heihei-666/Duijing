"""对镜 · 评测集 —— 规则校验层（免费、确定性、可在 CI 跑）

【为什么要有这一层】

这是岗位调研里 ROI 最高的一项：面试必问「你改了 prompt，怎么知道变好了还是变坏了」，
而在此之前这个项目**答不上来**。`tests/test_ai_layer.py` 测的全是管道
（路由对不对、JSON 能不能抠出来），**没有一条在评估模型输出的质量**。

【分层设计（方案 A）】

    ┌─ 规则校验（本文件）  免费 · 确定性 · 秒级 ──→ 进 CI 当门禁
    └─ LLM-as-judge       花钱 · 需要 Key      ──→ 本地/服务器手动跑，出质量报告

CI 只跑第一层：它挡的是**硬错误**——JSON 不合 schema、观察超了上限、
输出了「你很棒」这类放到谁身上都成立的废话。这些都是确定性的，不需要调模型，
所以免费、快、不会让 CI 变成不稳定因素。

【这里**不**做什么】

它不评价「这条观察准不准」——那需要判断力，是 judge 的活。
把不能确定性判定的东西塞进 CI，只会得到一堆 flaky 测试。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

# 方案第九章第 5 条：每场最多 1 优势 + 1 弱点 + 1 替代动作。**不许多给。**
MAX_OBSERVATIONS_PER_TYPE = 1

# 观察名称的长度上限。后端的 `_create_observations` 会截到 120 字符，
# 但一条 120 字的「观察」已经不是标签而是段落了，对用户没有用。
MAX_OBSERVATION_CHARS = 40

# 放到谁身上都成立的废话。这类输出**比没有输出更糟**——
# 用户会以为 AI 真的观察了他，而它会一路污染弱点库。
GENERIC_PHRASES = (
    "你很棒",
    "表现不错",
    "继续加油",
    "有待提高",
    "需要改进",
    "你做得很好",
    "整体不错",
    "还需努力",
    "要注意",
    "有待加强",
    "有进步空间",
    "值得表扬",
)

# 观察必须落在方案 3.1 的四层里。名称里至少要能看出指向某一层。
LAYER_HINTS = {
    "论证结构": ("论据", "论点", "支撑", "偷换", "概念", "逻辑", "因果", "证据", "举例"),
    "情绪与防御": ("回避", "防御", "情绪", "硬撑", "转移", "否认", "急躁", "紧张", "承认"),
    "互动策略": ("复述", "提问", "打断", "回应", "倾听", "追问", "对话", "反问"),
    "语言习惯": ("句式", "口头禅", "类比", "数据", "重复", "术语", "措辞", "比喻"),
}


@dataclass
class CaseResult:
    case_id: str
    passed: bool
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.case_id,
            "passed": self.passed,
            "failures": self.failures,
            "notes": self.notes,
        }


def load_golden(name: str = "observations.jsonl") -> list[dict]:
    """读 golden set。每行一个 JSON 对象。"""
    path = GOLDEN_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"找不到 golden set：{path}")

    cases: list[dict] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        try:
            cases.append(json.loads(raw))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path.name} 第 {lineno} 行不是合法 JSON：{exc}") from exc
    return cases


def validate_case_shape(case: dict) -> list[str]:
    """校验用例本身写得对不对 —— golden set 自己坏掉是最隐蔽的失败。"""
    problems: list[str] = []
    for key in ("id", "layer", "topic", "stance", "user_turns"):
        if key not in case:
            problems.append(f"缺少字段 {key!r}")
    if case.get("layer") not in LAYER_HINTS:
        problems.append(f"layer 必须是四层之一，实际 {case.get('layer')!r}")
    turns = case.get("user_turns")
    if not isinstance(turns, list) or len(turns) < 2:
        problems.append("user_turns 至少要有 2 轮，否则不构成一场辩论")
    return problems


def check_observations(
    case: dict,
    *,
    weakness: str | None,
    advantage: str | None,
    review_blocks: dict[str, str] | None = None,
) -> CaseResult:
    """对一场辩论的产出做规则校验。

    参数就是最终会落库的东西：弱点观察名、优势观察名、复盘三个文本块。
    """
    result = CaseResult(case_id=case["id"], passed=True)
    observations = [o for o in (weakness, advantage) if o]

    # 1) 上限：不多给
    if len(observations) > 2:
        result.failures.append(f"观察条数 {len(observations)} 超过上限 2")

    # 2) 不能是放到谁身上都成立的废话
    for obs in observations:
        for phrase in GENERIC_PHRASES:
            if phrase in obs:
                result.failures.append(f"观察 {obs!r} 含通用废话 {phrase!r}")

    # 3) 长度：观察是标签，不是段落
    for obs in observations:
        if len(obs) > MAX_OBSERVATION_CHARS:
            result.failures.append(
                f"观察过长（{len(obs)} > {MAX_OBSERVATION_CHARS} 字）：{obs[:60]}…"
            )

    # 4) 不能复读辩题或用户原话（那是最偷懒的「观察」）
    topic = case.get("topic", "")
    for obs in observations:
        normalized = re.sub(r"\s+", "", obs)
        if topic and re.sub(r"\s+", "", topic) == normalized:
            result.failures.append(f"观察直接复读了辩题：{obs!r}")

    # 5) 必须能看出指向哪一层（方案 3.1 的四层观察）
    if observations:
        hit = any(
            any(hint in obs for hint in LAYER_HINTS[case["layer"]])
            for obs in observations
        )
        if not hit:
            result.notes.append(
                f"观察未命中 {case['layer']} 的任何提示词——可能是另一层，"
                f"也可能是措辞太泛（judge 那一层会判）"
            )

    # 6) 复盘三个块不能是空的（方案 3.1：复盘卡片三块）
    if review_blocks is not None:
        for block in ("good", "notice", "next_time"):
            if not (review_blocks.get(block) or "").strip():
                result.failures.append(f"复盘块 {block!r} 为空")

    # 7) 用户明确要求「不要出现」的内容
    for forbidden in case.get("forbid_substrings", []):
        for obs in observations:
            if forbidden in obs:
                result.failures.append(f"观察含禁止内容 {forbidden!r}：{obs!r}")

    result.passed = not result.failures
    return result


def summarize(results: list[CaseResult]) -> dict:
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    failures: dict[str, int] = {}
    for r in results:
        for f in r.failures:
            key = f.split("：")[0].split("（")[0]
            failures[key] = failures.get(key, 0) + 1
    return {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "pass_rate": round(passed / total, 4) if total else None,
        "failure_kinds": dict(sorted(failures.items(), key=lambda kv: -kv[1])),
    }
