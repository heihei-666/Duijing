"""对镜 · 评测集 —— LLM-as-judge 打分层

【它和规则校验层的分工】

    规则校验（checks.py）  确定性：schema、上限、废话黑名单、长度
                           → 能证明「管道没坏」，证明不了「观察准不准」

    judge（本文件）        判断力：这条观察是否**只适用于这场辩论**、
                           用户能否据此改变行为、有没有辩论里的依据
                           → 这才是「模型输出质量」的度量

**为什么必须用不同的模型当裁判**：被测的观察提取走 MiMo（方案 5.3 的路由），
如果裁判也用 MiMo，等于让同一个模型给自己的输出打分，系统性偏袒无法被发现。
这里默认用 DeepSeek，并用 `EVAL_JUDGE_PROVIDER` 可配。

【judge 自己也有偏见，所以】

  · 分数**只做相对比较**（改 prompt 前后跑同一套），不当作绝对真理
  · `--calibrate` 会打印若干条人工可复核的样本，用来估算 judge 与人的一致率；
    报告里如实写这个数，而不是只报一个漂亮的总分
  · `is_generic` 用布尔而不是打分——「是不是废话」这件事不该交给 1-5 的刻度去模糊
"""

from __future__ import annotations

import json
import os
import statistics
from os import PathLike

from app.ai.base import ChatMessage
from app.ai.router import extract_json

JUDGE_PROVIDER = os.environ.get("EVAL_JUDGE_PROVIDER", "deepseek")

_SYSTEM = """你是「对镜」这个产品的质量评审。这个产品用 AI 辩论房照见用户的思维与情绪模式，
产品的全部价值建立在「AI 的观察是具体的、有依据的」之上——
一条放到谁身上都成立的废话，比没有观察更糟，因为用户会以为 AI 真的看见了他。

下面给你：① 用户在一场辩论里的发言；② AI 从这场辩论里抽出的弱点观察与优势观察。

请对**每一条观察**打分。只输出 JSON，不要解释文字，不要代码围栏。

打分维度（1-5 分）：
  specificity   这条观察有多**只适用于这场辩论**？5=必须读了这些发言才写得出来；
                1=放到任何一场辩论里都成立（例如「表达不够清晰」）
  grounded      有没有辩论里的**具体行为或原话**作为依据？5=能指回某几轮发言；1=凭空
  actionability 用户看完能**改变什么具体行为**？5=知道下一步做什么；1=只是被评价了

另外两个布尔：
  is_generic    是不是「你很棒」「继续加油」这类放到谁身上都成立的废话
  mislabeled    如果这条观察明显该属于另一个维度（论证结构/情绪与防御/互动策略/语言习惯），
                或它的判断与发言内容相矛盾，则为 true

格式（每条都必填，没有的给 null）：
{"weakness":{"specificity":n,"grounded":n,"actionability":n,"is_generic":bool,"mislabeled":bool,"reason":"20字内"},
 "advantage":{"specificity":n,"grounded":n,"actionability":n,"is_generic":bool,"mislabeled":bool,"reason":"20字内"}}
"""

_LAYERS = ("论证结构", "情绪与防御", "互动策略", "语言习惯")


def _provider():
    """拿裁判用的 provider。**刻意不复用 AI_PROVIDER 的路由** —— 见文件头说明。"""
    from app.ai.providers import DeepSeekProvider, MiMoProvider

    if JUDGE_PROVIDER == "mimo":
        return MiMoProvider()
    return DeepSeekProvider()


def _build_messages(case: dict, weakness: str | None, advantage: str | None) -> list[ChatMessage]:
    turns = "\n".join(f"  {i + 1}. {t}" for i, t in enumerate(case["user_turns"]))
    observations = []
    observations.append(f"弱点观察：{weakness}" if weakness else "弱点观察：（AI 没有给出）")
    observations.append(f"优势观察：{advantage}" if advantage else "优势观察：（AI 没有给出）")
    return [
        ChatMessage(role="system", content=_SYSTEM),
        ChatMessage(
            role="user",
            content=(
                f"【辩题】{case['topic']}\n"
                f"【用户立场】{case['stance']}\n"
                f"【预期观察维度】{case['layer']}\n"
                f"【用户在这场辩论里的发言】\n{turns}\n\n"
                f"【AI 抽出的观察】\n" + "\n".join(observations)
            ),
        ),
    ]


_SCORE_KEYS = ("specificity", "grounded", "actionability")


def _flatten(parsed: dict, kind: str) -> dict | None:
    block = parsed.get(kind)
    if not isinstance(block, dict):
        return None
    out: dict = {"kind": kind}
    for key in _SCORE_KEYS:
        value = block.get(key)
        out[key] = value if isinstance(value, (int, float)) else None
    out["is_generic"] = bool(block.get("is_generic"))
    out["mislabeled"] = bool(block.get("mislabeled"))
    out["reason"] = (block.get("reason") or "").strip()[:60]
    scored = [out[k] for k in _SCORE_KEYS if out[k] is not None]
    out["mean"] = round(statistics.fmean(scored), 2) if scored else None
    return out


async def judge_case(
    case: dict, weakness: str | None, advantage: str | None, provider=None
) -> dict:
    """给一条用例的两条观察打分。"""
    provider = provider or _provider()
    if not provider.configured:
        return {"error": f"裁判 provider {JUDGE_PROVIDER} 没有配置 Key"}

    response = await provider.complete(
        _build_messages(case, weakness, advantage), temperature=0.0, max_tokens=700
    )
    parsed = extract_json(response.text)
    if parsed is None:
        return {"error": "judge 输出不是合法 JSON", "raw": (response.text or "")[:300]}

    return {
        "weakness": _flatten(parsed, "weakness"),
        "advantage": _flatten(parsed, "advantage"),
        "usage": {
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens,
        },
    }


def judge_all(details: list[dict], partial_path=None) -> dict:
    """对整批用例打分并汇总。

    汇总刻意**不报一个笼统的「总分」** —— 那个数字没有行动含义。
    报的是：平均 specificity / grounded / actionability、废话条数、
    以及**跨用例重复的观察**。最后一项是「模型在套模板」的直接证据：
    12 场不同的辩论如果抽出的是同样几条观察，那它根本没在读内容。

    `partial_path` 给定时，每判完一条就把中间结果落盘。
    **这是被真实事故逼出来的**：第一次在服务器上跑，进程在进入 judge 后静默死掉，
    30 条的打分全部丢失，只能从头再来一遍（再花一次钱）。
    """
    import asyncio

    from evals.checks import load_golden

    golden = {c["id"]: c for c in load_golden()}
    rows: list[dict] = [
        {"id": item["case"], "produced": item.get("produced") or {}, "judged": None}
        for item in details
    ]

    async def _run_all() -> None:
        provider = _provider()
        if not provider.configured:
            for row in rows:
                row["judged"] = {"error": f"裁判 provider {JUDGE_PROVIDER} 没有配置 Key"}
            return
        for index, row in enumerate(rows, 1):
            case = golden.get(row["id"])
            if case is None:
                row["judged"] = {"error": "golden set 里找不到这条用例"}
            else:
                row["judged"] = await judge_case(
                    case,
                    row["produced"].get("weakness"),
                    row["produced"].get("advantage"),
                    provider=provider,
                )
            mark = "·" if not row["judged"].get("error") else "!"
            print(f"  [{index}/{len(rows)}] {mark} {row['id']}", flush=True)
            if partial_path is not None:
                partial_path.write_text(
                    json.dumps({"rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8"
                )

    asyncio.run(_run_all())

    scored = [r for r in rows if r["judged"] and "error" not in r["judged"]]
    means: dict[str, list[float]] = {k: [] for k in _SCORE_KEYS}
    generic_hits: list[str] = []
    mislabeled_hits: list[str] = []
    errors: list[str] = []
    seen: dict[str, list[str]] = {"weakness": [], "advantage": []}

    for row in rows:
        judged = row["judged"] or {}
        if "error" in judged:
            errors.append(f"{row['id']}: {judged['error']}")
            continue
        for kind in ("weakness", "advantage"):
            block = judged.get(kind)
            text = row["produced"].get(kind)
            if not block or not text:
                continue
            seen[kind].append(text)
            for key in _SCORE_KEYS:
                if block.get(key) is not None:
                    means[key].append(float(block[key]))
            if block.get("is_generic"):
                generic_hits.append(f"{row['id']}.{kind}={text}")
            if block.get("mislabeled"):
                mislabeled_hits.append(f"{row['id']}.{kind}={text}")

    duplicates = {
        kind: sorted({t for t in texts if texts.count(t) > 1})
        for kind, texts in seen.items()
    }

    return {
        "judge_provider": JUDGE_PROVIDER,
        "judged_cases": len(scored),
        "errors": errors,
        "averages": {k: (round(statistics.fmean(v), 2) if v else None) for k, v in means.items()},
        "generic_count": len(generic_hits),
        "generic_examples": generic_hits[:5],
        "mislabeled_count": len(mislabeled_hits),
        "mislabeled_examples": mislabeled_hits[:5],
        # 「模型在套模板」的直接证据
        "repeated_observations": {k: v for k, v in duplicates.items() if v},
        "rows": rows,
    }


def judge_report(source: PathLike) -> "Path | None":
    """读一份规则层报告，给里面每条观察打分，另写一份 judge 报告。

    **为什么要独立成一步**：judge 只需要 golden set + 已产出的观察，
    完全不必把整个 App 再跑一遍。分开之后：
      · 轻量得多（不起 FastAPI、不建库、不发几十次生成调用）
      · 崩了可以单独重跑，不用重付生成那部分的钱
      · 每判完一条就落盘，再崩也不会全丢
    """
    import json as _json
    from datetime import datetime
    from pathlib import Path as _Path

    source = _Path(source)
    if not source.exists():
        print(f"❌ 找不到规则层报告：{source}")
        return None

    payload = _json.loads(source.read_text(encoding="utf-8"))
    details = payload.get("cases") or []
    if not details:
        print("❌ 报告里没有 cases")
        return None

    reports_dir = source.parent
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = reports_dir / f"judge-{stamp}.json"
    partial = reports_dir / f"judge-{stamp}.partial.json"

    print(f"待判用例：{len(details)}   裁判：{JUDGE_PROVIDER}")
    print(f"中间结果落盘到：{partial.name}（每判完一条写一次）")
    verdict = judge_all(details, partial_path=partial)

    merged = {
        "mode": "judge",
        "judge_provider": JUDGE_PROVIDER,
        "ran_at": stamp,
        "source_report": source.name,
        "source_summary": payload.get("summary"),
        "generation_usage": payload.get("usage"),
        **verdict,
    }
    out.write_text(_json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    partial.unlink(missing_ok=True)

    print("\n================ judge 结果 ================")
    avg = verdict["averages"]
    print(f"裁判模型          : {verdict['judge_provider']}")
    print(f"完成打分          : {verdict['judged_cases']} 条")
    print(f"具体性  (5分制)   : {avg['specificity']}")
    print(f"有依据  (5分制)   : {avg['grounded']}")
    print(f"可执行性(5分制)   : {avg['actionability']}")
    print(f"判为废话          : {verdict['generic_count']} 条")
    print(f"判为错标          : {verdict['mislabeled_count']} 条")
    repeated = verdict["repeated_observations"]
    if repeated:
        print("跨用例重复的观察（模型在套模板的直接证据）：")
        for kind, items in repeated.items():
            for text in items:
                print(f"   {kind}: {text}")
    else:
        print("跨用例重复的观察  : 无 —— 每条观察都是针对本场辩论生成的")
    if verdict["errors"]:
        print(f"出错 {len(verdict['errors'])} 条：{verdict['errors'][:3]}")
    return out


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="对镜 · 评测集 judge 层（可独立重跑）")
    parser.add_argument("--report", required=True, help="规则层报告 JSON 的路径")
    args = parser.parse_args()
    return 0 if judge_report(args.report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
