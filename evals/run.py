"""对镜 · 评测集运行器

用法：

    # 规则校验（免费、确定性、CI 用这个）
    python -m evals.run --mode rules

    # 规则校验 + LLM-as-judge 打分（需要真实 Key，会花钱）
    python -m evals.run --mode judge

【它跑的是真链路，不是单测】

每条用例走的是和生产完全一样的路径：
建辩论房（AI 出开场白）→ 用户逐轮发言 → 结束并复盘 → 落库的观察与复盘卡片。
评测不另起一套「评测专用」的调用方式——那样测出来的东西和生产不是一个东西。

**刻意不走 SSE**：AI 的每轮回复要靠流式接口拿，而复盘只依赖已落库的对话记录。
省掉 SSE 让评测可以纯粹用 TestClient 跑完，不引入并发和超时的不确定性。

【产出】

    evals/reports/rules-<时间戳>.json     逐条结果 + 汇总
    evals/reports/judge-<时间戳>.json     额外含每条观察的评分
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REPORTS = Path(__file__).resolve().parent / "reports"
sys.path.insert(0, str(REPO_ROOT))


def _bootstrap_env() -> None:
    """必须在 import app 之前设好 —— app.config 在导入时就实例化了 Settings。

    与 tests/conftest.py 同一套做法，但**刻意不共用**：
    评测要能独立地在服务器上跑（那里没有 tests/ 的运行环境）。
    """
    tmp = tempfile.mkdtemp(prefix="duijing-eval-")
    os.environ.setdefault("DB_PATH", os.path.join(tmp, "eval.db"))
    os.environ.setdefault("ENABLE_SCHEDULER", "false")
    # 默认 mock：CI 里不配置任何 Key 也能跑，且结果确定
    os.environ.setdefault("AI_PROVIDER", "mock")
    os.environ.setdefault("JWT_SECRET", "eval-secret-not-for-production")
    os.environ.setdefault("COOKIE_SECURE", "false")
    os.environ.setdefault("ENV", "eval")
    os.environ.setdefault("BOOTSTRAP_INVITE_CODE", "")
    # 评测会连续建几十个账号，不放开限流会一路撞 429
    os.environ.setdefault("LOGIN_RATE_PER_MIN", "100000")
    os.environ.setdefault("DEBATE_RATE_PER_MIN", "100000")
    os.environ.setdefault("AI_RATE_PER_MIN", "100000")
    os.environ.setdefault("LOGIN_LOCK_THRESHOLD", "100000")


_bootstrap_env()

from fastapi.testclient import TestClient  # noqa: E402

from app.ai.mock import MockProvider  # noqa: E402
from evals import checks  # noqa: E402


def _bootstrap_invite(client: TestClient) -> str:
    """先注册第一个账号，换回邀请码。

    产品规则：**第一个注册的账号自动成为管理员、免邀请码；之后所有人必须凭码**。
    评测要遵守这条规则，不能给自己开后门——第一次跑就撞了这个 400，
    说明规则在生产里确实是生效的。
    """
    resp = client.post(
        "/api/auth/register",
        json={"username": "eval_bootstrap", "password": "EvalBootPass123", "nickname": "评测引导"},
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"引导账号创建失败 {resp.status_code}: {resp.text[:200]}")
    code = resp.json().get("invite_code", "")
    client.cookies.clear()
    if not code:
        raise RuntimeError("引导账号没有返回 invite_code，后续用例无法注册")
    return code


def _run_case(client: TestClient, case: dict, index: int, invite: str) -> dict:
    """跑一条用例，返回它的产出（观察 + 复盘）。"""
    username = f"eval{index}_{case['id'].replace('-', '_')}"
    password = "EvalPass123"

    reg = client.post(
        "/api/auth/register",
        json={
            "username": username,
            "password": password,
            "nickname": username,
            "invite_code": invite,
        },
    )
    if reg.status_code not in (200, 201):
        return {"error": f"注册失败 {reg.status_code}: {reg.text[:200]}"}
    token = reg.json()["token"]
    client.cookies.clear()
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/debates",
        json={"topic": case["topic"], "stance": case["stance"]},
        headers=headers,
    )
    if created.status_code not in (200, 201):
        return {"error": f"建辩论失败 {created.status_code}: {created.text[:200]}"}
    room_id = created.json()["room"]["id"]

    for turn in case["user_turns"]:
        resp = client.post(
            f"/api/debates/{room_id}/messages",
            json={"content": turn},
            headers=headers,
        )
        if resp.status_code not in (200, 201):
            return {"error": f"发言失败 {resp.status_code}: {resp.text[:200]}"}

    finished = client.post(f"/api/debates/{room_id}/finish", headers=headers)
    if finished.status_code not in (200, 201):
        return {"error": f"复盘失败 {finished.status_code}: {finished.text[:200]}"}

    review = finished.json().get("review") or {}

    def _block(key: str) -> str:
        """复盘三块的形状是 {title, content}，不是裸字符串。

        踩过一次：直接把 review["good"] 当字符串 .strip()，拿到的是 dict → AttributeError。
        """
        value = review.get(key)
        if isinstance(value, dict):
            return (value.get("content") or "").strip()
        return (value or "").strip() if isinstance(value, str) else ""

    # review 里已经带了本场产出的观察，不必再查一次接口。
    # 但保留接口回退：万一将来 review 不再内联观察，评测不至于静默变成「零观察」。
    observations = review.get("observations")
    if not isinstance(observations, list):
        obs_resp = client.get("/api/observations?status=pending,accepted", headers=headers)
        observations = (
            obs_resp.json().get("observations", []) if obs_resp.status_code == 200 else []
        )

    weakness = next((o["content"] for o in observations if o["type"] == "weakness"), None)
    advantage = next((o["content"] for o in observations if o["type"] == "advantage"), None)

    return {
        "room_id": room_id,
        "weakness": weakness,
        "advantage": advantage,
        "observation_count": len(observations),
        "review_blocks": {
            "good": _block("good"),
            "notice": _block("notice"),
            "next_time": _block("next_time"),
        },
        "alternative_action": (review.get("alternative_action") or "").strip(),
    }


def run(mode: str, limit: int | None) -> int:
    cases = checks.load_golden()
    if limit:
        cases = cases[:limit]

    # golden set 自己写坏了是最隐蔽的失败 —— 先校验它
    shape_problems: list[str] = []
    for case in cases:
        for problem in checks.validate_case_shape(case):
            shape_problems.append(f"{case.get('id', '?')}: {problem}")
    if shape_problems:
        print("❌ golden set 本身有问题：")
        for p in shape_problems:
            print("   -", p)
        return 2

    print(f"评测模式：{mode}   用例数：{len(cases)}   AI_PROVIDER={os.environ['AI_PROVIDER']}")
    print("-" * 72)

    MockProvider.stream_delay = 0

    from app.main import app

    results: list[checks.CaseResult] = []
    details: list[dict] = []

    with TestClient(app) as client:
        invite = _bootstrap_invite(client)

        for index, case in enumerate(cases):
            produced = _run_case(client, case, index, invite)
            if "error" in produced:
                r = checks.CaseResult(case["id"], passed=False, failures=[produced["error"]])
            else:
                r = checks.check_observations(
                    case,
                    weakness=produced["weakness"],
                    advantage=produced["advantage"],
                    review_blocks=produced["review_blocks"],
                )
            results.append(r)
            details.append({"case": case["id"], "layer": case["layer"], "produced": produced, **r.as_dict()})
            mark = "✅" if r.passed else "❌"
            obs = f"弱={produced.get('weakness') or '—'} 优={produced.get('advantage') or '—'}"
            print(f"{mark} {case['id']:<8} [{case['layer']}]  {obs}")
            for f in r.failures:
                print(f"     ✗ {f}")

    summary = checks.summarize(results)
    print("-" * 72)
    print(f"规则校验：{summary['passed']}/{summary['total']} 通过"
          f"（通过率 {summary['pass_rate']}）")
    if summary["failure_kinds"]:
        print("失败类型分布：")
        for kind, n in summary["failure_kinds"].items():
            print(f"   {n:>3} 次  {kind}")

    REPORTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = REPORTS / f"{mode}-{stamp}.json"
    payload = {
        "mode": mode,
        "ai_provider": os.environ["AI_PROVIDER"],
        "ran_at": stamp,
        "summary": summary,
        "cases": details,
    }

    if mode == "judge":
        from evals.judge import judge_all

        print("\n开始 LLM-as-judge 打分（会调用真实模型）…")
        payload["judge"] = judge_all(details)

    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告已写入：{out.relative_to(REPO_ROOT)}")
    return 0 if summary["failed"] == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="对镜 · 评测集")
    parser.add_argument("--mode", choices=["rules", "judge"], default="rules")
    parser.add_argument("--limit", type=int, default=None, help="只跑前 N 条（调试用）")
    args = parser.parse_args()
    return run(args.mode, args.limit)


if __name__ == "__main__":
    raise SystemExit(main())
