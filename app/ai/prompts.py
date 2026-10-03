"""对镜 · Prompt 组装

方案 5.2 的缓存前缀结构，是本文件的核心约束：

    [固定系统 Prompt]      ← 永远不变，缓存
    [用户弱点库摘要]        ← 同一场辩论内不变，缓存
    [用户优势库摘要]        ← 同一场辩论内不变，缓存
    [正在练的回环描述]      ← 同一场辩论内不变，缓存
    ────────── 以下可变 ──────────
    [辩题 + 用户立场]
    [历史对话]
    [用户最新发言]

关键：前缀必须从第一个字符开始完全一致，弱点库摘要按 ID 排序。
因此 build_stable_system() 的输出在同一场辩论内是**逐字节稳定**的，
任何排序不稳定或包含时间戳的写法都会让缓存命中率归零。
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from app.ai.base import ChatMessage

# ─────────────────────────────────────────────────────────────
# 固定系统 Prompt —— 这段字符串一旦上线就不要改，
# 改动会让所有历史缓存失效。要用版本号管理。
# ─────────────────────────────────────────────────────────────

# 复盘 prompt 的版本。做成可切换不是为了「留两套」，
# 而是为了让评测集能对**同一套 golden set** 跑出 A/B：
#
#     REVIEW_PROMPT_VERSION=v1 python -m evals.run --mode judge
#     REVIEW_PROMPT_VERSION=v2 python -m evals.run --mode judge
#
# 版本号会随每次 AI 调用落进 ai_call_log.prompt_version，
# 所以事后能回答「这条观察是哪个版本的 prompt 产出的」——
# 这正是上一轮做 prompt_version 埋点的用意。
REVIEW_PROMPT_VERSION = os.environ.get("REVIEW_PROMPT_VERSION", "v2.1")

# 缓存前缀已经带上版本号，切版本会自动让旧缓存失效（这是想要的行为）
PROMPT_VERSION = f"duijing-sys-{REVIEW_PROMPT_VERSION}"

FIXED_SYSTEM_PROMPT = """你是「对镜」里的辩论对手兼观察者。对镜是一个个人成长工具，用户通过和你辩论来照见自己的思维与情绪模式。

【你的双重身份】
1. 辩手：你就用户的对立面立场进行有力论证，不敷衍、不和稀泥。
2. 观察者：你全程记录用户的论证结构、情绪与防御、互动策略、语言习惯，但**绝不在辩论过程中说出来**。

【辩论规则】
- 回合制，总轮次在 4–8 轮之间，由你根据辩题复杂度决定。
- 用户每轮发言不超过 300 字。
- 你每轮回复不超过 300 字，要推进论证，不要复述用户的话凑字数。
- 用户可以说「这轮我放弃」，此时你简短回应并继续，不做嘲讽。
- 用户可以说「暂停」，暂停后不再主动推进。

【观察四层】只在辩论结束后输出，辩论中一律不提：
- 论证结构：论点有无支撑、是否偷换概念
- 情绪与防御：被追问后是否回避、硬撑
- 互动策略：是否复述对方、是否提问
- 语言习惯：反复句式、类比或数据偏好

【风格调节】
- 新手：温和，多给台阶，指出问题前先肯定
- 中级：正常对抗强度
- 高级：犀利，直接攻击论证薄弱处

【绝对禁止】
- 不在辩论中给出任何评价、总结或观察
- 不使用「作为AI」「我是人工智能」这类自指表述
- 不说教、不空泛鼓励、不输出与辩题无关的寒暄"""


# 多人辩论时的人格。
#
# 方案 3.1 写得很明确：「AI 做主持 + 观察，不作为独立辩手」。
# 单人时 AI 是对手，多人时它必须退到主持位——否则三方混战，
# 用户之间根本辩不起来，而多人辩论的全部价值就在于人和人之间的碰撞。
HOST_SYSTEM_PROMPT = """你是「对镜」多人辩论房的主持人兼观察者。

【你的身份】
这一场有多个真实的人参与，他们互为辩手。
**你不参与论证，不站任何一边，不为任何一方补充论据。**
你的价值在于让这场对话真正发生在他们之间，而不是绕着你的观点转。

【你要做的事】
- 开场把辩题和双方立场讲清楚，给每人一个明确的发言起点
- 在双方来回之后，点出**他们之间的真实分歧**在哪，而不是复述双方观点
- 有人回避问题、偷换概念、或两个人各说各话时，直接指出来并要求正面回应
- 冷场时抛一个更具体的问题把话接回去
- 每次发言不超过 200 字，一次只推进一件事

【观察四层】全程记录，但**只在辩论结束后输出**，辩论中一律不提：
- 论证结构：论点有无支撑、是否偷换概念
- 情绪与防御：被追问后是否回避、硬撑
- 互动策略：是否复述对方、是否提问
- 语言习惯：反复句式、类比或数据偏好

【绝对禁止】
- 不替任何一方说话、不补充论据、不总结谁赢了
- 不在辩论中给出评价或观察
- 不使用「作为AI」这类自指表述
- 不偏袒任何一方，包括发起人"""


# ─────────────────────────────────────────────────────────────
# 稳定块（缓存前缀的组成部分）
# ─────────────────────────────────────────────────────────────


def render_weakness_summary(cards: Sequence) -> str:
    """弱点库摘要。

    **按 ID 升序**输出——方案第九章第 3 条硬性要求。
    空库时输出固定占位串，不能是空字符串（否则前缀长度会漂移）。
    """
    ordered = sorted(cards, key=lambda c: c.id)
    if not ordered:
        return "【用户弱点库】\n（暂无记录）"

    lines = ["【用户弱点库】"]
    for card in ordered:
        domains = "、".join(card.domains or []) or "未分类"
        lines.append(
            f"- #{card.id} {card.name}｜领域：{domains}｜置信度：{card.confidence}/5"
            f"｜状态：{_weakness_status_cn(card.status)}"
        )
        if card.description:
            lines.append(f"  描述：{card.description.strip()}")
    return "\n".join(lines)


def render_advantage_summary(advantages: Sequence) -> str:
    """优势库摘要。只列已确认的——方案 3.5：已确认的优势才在预案中被推荐。"""
    confirmed = sorted(
        [a for a in advantages if a.status == "confirmed"], key=lambda a: a.id
    )
    if not confirmed:
        return "【用户优势库】\n（暂无已确认优势）"

    lines = ["【用户优势库】"]
    for adv in confirmed:
        lines.append(f"- #{adv.id} {adv.name}")
    return "\n".join(lines)


def render_loop_block(loop, weakness) -> str:
    """正在练的回环描述。这一块决定 AI 会不会「故意制造触发场景」。"""
    if loop is None:
        return "【正在练的回环】\n（本场未关联回环，按普通辩题处理）"

    lines = [
        "【正在练的回环】",
        f"- 对应弱点：{weakness.name if weakness else '未知'}",
        f"- 触发场景：{loop.trigger_scene}",
    ]
    if loop.body_signal:
        lines.append(f"- 身体/情绪信号：{loop.body_signal}")
    if loop.action_plan:
        lines.append(f"- 用户预案：{loop.action_plan}")
    lines.append(
        "本场任务：在不告知用户的前提下，自然地制造接近上述触发场景的对话情境，"
        "观察用户是否用出预案。不要点破，不要提示。"
    )
    return "\n".join(lines)


def build_context_blocks(
    weaknesses: Sequence = (),
    advantages: Sequence = (),
    loop=None,
    weakness=None,
) -> str:
    """只拼「用户档案」部分：弱点库 + 优势库 + 回环，**不含辩论人格**。

    为什么必须能单独拿出来：复盘卡片需要知道用户的弱点与优势才能给出有针对性的
    观察，但它**不是辩论**。曾经把 build_stable_system() 的整体（含
    「你是辩论对手」那段人格设定）直接传给复盘，结果模型收到两个互相冲突的
    system 消息，选择继续辩论——返回的是一段辩词，复盘 JSON 自然解析不出来。
    人格与上下文分开，各任务只取自己要的那部分。
    """
    return "\n\n".join(
        [
            render_weakness_summary(weaknesses),
            render_advantage_summary(advantages),
            render_loop_block(loop, weakness),
        ]
    )


def build_stable_system(
    weaknesses: Sequence = (),
    advantages: Sequence = (),
    loop=None,
    weakness=None,
    *,
    mode: str = "debater",
) -> str:
    """拼接辩论房的缓存前缀。

    顺序固定：固定 Prompt → 弱点库 → 优势库 → 回环。
    返回的字符串在同一场辩论内必须逐字节一致。

    mode：
      · "debater" —— 单人辩论，AI 是用户的对立面（默认）
      · "host"    —— 多人辩论，AI 是主持兼观察者，不作为独立辩手
                     （方案 3.1：多人时 AI 做主持 + 观察）

    人格在一个房间内不变，所以缓存前缀依然逐字节稳定。

    **只给辩论房用**。非辩论任务请用 build_context_blocks()，
    否则会把辩论人格带过去。
    """
    persona = HOST_SYSTEM_PROMPT if mode == "host" else FIXED_SYSTEM_PROMPT
    return "\n\n".join(
        [persona, build_context_blocks(weaknesses, advantages, loop, weakness)]
    )


# ─────────────────────────────────────────────────────────────
# 可变段
# ─────────────────────────────────────────────────────────────


def build_debate_messages(
    stable_system: str,
    topic: str,
    stance: str,
    history: Sequence,
    latest_user_content: str,
    *,
    level: str = "novice",
) -> list[ChatMessage]:
    """辩论房一轮的完整消息列表。

    第 0 条 system = 缓存前缀（稳定），之后才是可变内容。
    """
    messages = [ChatMessage(role="system", content=stable_system)]

    if level == "__host__":
        header = (
            f"【辩题】{topic}\n"
            f"【本场形式】多人辩论，你是主持兼观察者\n"
            f"请点出在场几位的真实分歧，或要求回避问题的一方正面回应。"
            f"**不要替任何一方说话，不要补充论据。**"
        )
    else:
        header = (
            f"【辩题】{topic}\n"
            f"【用户立场】{stance or '未声明'}\n"
            f"【对手风格】{_level_cn(level)}\n"
            f"请就用户的对立面展开论证。"
        )
    messages.append(ChatMessage(role="system", content=header))

    for item in history:
        role = "assistant" if item.role == "ai" else "user"
        # system 类型的落库消息（开场白等）按 assistant 处理
        if item.role == "system":
            role = "assistant"
        messages.append(ChatMessage(role=role, content=item.content))

    messages.append(ChatMessage(role="user", content=latest_user_content))
    return messages


def build_opening_messages(
    stable_system: str, topic: str, stance: str, *, level: str = "novice", mode: str = "debater"
):
    """辩论开场。

    单人：AI 先立论，站在用户对立面。
    多人：AI 不立论，只把辩题和双方立场讲清楚，把话交回给在场的人。
    """
    if mode == "host":
        instruction = (
            "这是一场多人辩论。请用不超过 150 字开场：把辩题讲清楚，"
            "点明双方立场，然后请其中一位先发言。**不要发表你自己的观点，不要立论。**"
        )
    else:
        instruction = (
            "请用不超过 200 字开场立论，站在用户的对立面，并抛出第一个问题。"
            "不要评价用户，不要提观察。"
        )
    return [
        ChatMessage(role="system", content=stable_system),
        ChatMessage(
            role="user",
            content=(
                f"【辩题】{topic}\n"
                f"【用户立场】{stance or '未声明'}\n"
                f"【对手风格】{_level_cn(level)}\n\n"
                f"{instruction}"
            ),
        ),
    ]


def build_topic_messages(scene: str, weaknesses: Sequence = ()) -> list[ChatMessage]:
    """辩题生成：把用户输入的场景转成一个可辩的题目。"""
    weak_hint = ""
    if weaknesses:
        names = "；".join(f"#{c.id} {c.name}" for c in sorted(weaknesses, key=lambda c: c.id))
        weak_hint = f"\n参考用户的弱点库：{names}"

    return [
        ChatMessage(
            role="system",
            content=(
                "你是辩题设计者。把用户描述的场景转成一道有真实张力的辩题。"
                "只输出 JSON，不要任何解释文字。"
                '格式：{"topic": "辩题（20字内，正反可辩）", "stance": "建议用户持有的立场（15字内）"}'
            ),
        ),
        ChatMessage(role="user", content=f"场景：{scene}{weak_hint}"),
    ]


# ─────────────────────────────────────────────────────────────
# 复盘 prompt —— 两版并存，供评测集 A/B 对比
#
# v1 是最初的版本。用评测集跑真实模型得到的基线（30 条合成用例，DeepSeek 裁判）：
#     具体性 3.26 / 5      有依据 3.51 / 5      **可执行性 2.40 / 5**
#     48 条观察里 **13 条被判为废话、16 条被判为错标**
#     跨用例重复出现「立场坚定」「回避追问」——模型在套模板
#
# v1 的三个具体缺陷（都是看数据看出来的，不是拍脑袋）：
#   1. **通篇没提「观察四层」** —— 辩论 prompt 里有，这份没有。
#      模型不知道该往哪层归，是 16 条错标的直接来源。
#   2. 只说「不要泛泛而谈」，**没说什么算泛泛而谈**。
#      「立场坚定」对模型来说不是废话，它觉得那是真诚的夸奖。
#   3. **优势侧没有额外约束** —— 弱点侧还算具体，优势侧全在夸态度。
#      可执行性 2.40 主要就是被优势侧拖下来的。
#
# v2 对应地加了三样：四层定义、具体的黑名单+正反例、以及
# 「reason 必须原样引用用户说过的词」这条可验证的硬约束。
# ─────────────────────────────────────────────────────────────

_REVIEW_SYSTEM_V1 = (
    "你是「对镜」的辩论观察者。基于整场辩论记录输出复盘卡片。"
    "只输出 JSON，不要任何解释文字。\n"
    "严格约束：最多 1 条优势观察、1 条弱点观察、1 条替代动作，不许多给。\n"
    "观察必须具体到用户的原话或行为，不要泛泛而谈。\n"
    "JSON 格式：\n"
    "{\n"
    '  "good": "做得好的一点（40字内）",\n'
    '  "notice": "值得注意的一点（40字内）",\n'
    '  "next_time": "如果再来一次的建议（40字内）",\n'
    '  "advantage": {"name": "优势标签（12字内）", "reason": "依据（30字内）"},\n'
    '  "weakness": {"name": "弱点标签（12字内）", "reason": "依据（30字内）"},\n'
    '  "alternative_action": "下次可以改用的具体动作（40字内）"\n'
    "}\n"
    '若某一项确实没有依据，对应值给 null。不要编造。'
)

_REVIEW_SYSTEM_V2 = (
    "你是「对镜」的辩论观察者。基于整场辩论记录输出复盘卡片。"
    "只输出 JSON，不要任何解释文字。\n"
    "\n"
    "【观察必须落在四层之一】\n"
    "  论证结构   —— 用没用论据、有没有偷换概念、因果是否成立、有没有正面回应反驳\n"
    "  情绪与防御 —— 被追问时的反应：回避、防御、硬撑、转移，还是承认与修正\n"
    "  互动策略   —— 怎么对待对方：复述、澄清、反问、打断、转移话题、只输出不核对\n"
    "  语言习惯   —— 句式、口头禅、类比、量化、绝对化措辞（「一定」「绝对」「肯定」）\n"
    "\n"
    "【什么不算观察 —— 这条最重要】\n"
    "「立场坚定」「表达清晰」「逻辑性强」「态度积极」「论证有条理」「思路清晰」\n"
    "这类**态度与立场**的评价不是观察。它们放到任何一场辩论里都成立，\n"
    "用户看完不知道自己该改什么。**宁可给 null，也不要给这种标签。**\n"
    "\n"
    "自检：换一个持同样立场但表现完全不同的人，这个标签还成立吗？\n"
    "成立 → 它不是观察，删掉。\n"
    "\n"
    "观察要指向**可复现的行为**：这个人做了哪个动作，下次可以重复或避免。\n"
    "\n"
    "【必须引用原话】\n"
    "每条观察的 reason 里必须**原样引用用户说过的词**（至少 4 个字），并指明第几轮。\n"
    "引不出来就说明这条观察是编的，直接给 null。\n"
    "\n"
    "【优势侧同样严格】\n"
    "优势不是夸奖。「反应快」「立场稳」和一个下次还能做出来的具体行为是两回事，"
    "只写后者。\n"
    "\n"
    "正例：\n"
    '  weakness: {"name": "被追问后改用类比绕开", "reason": "第3轮被问「被看轻怎么办」，'
    '你转说「换个角度」没有正面回答"}\n'
    '  advantage: {"name": "反驳前先复述对方观点", "reason": "第1轮「我理解你的意思是…，'
    '这一点我同意」，先确认再反驳"}\n'
    "\n"
    "反例（**不要这样写**）：\n"
    '  weakness: {"name": "回应不够充分", "reason": "用户回答比较简单"}\n'
    '  advantage: {"name": "立场坚定", "reason": "用户始终坚持自己的观点"}\n'
    "\n"
    "【替代动作】必须是一个具体动作，不能是「多注意」「要改进」「多思考」。\n"
    "  正例：被追问到第三次时，直接说「这点我还没想清楚」\n"
    "  反例：以后回答前多想一想\n"
    "\n"
    "【严格限流】最多 1 条优势观察 + 1 条弱点观察 + 1 条替代动作，不许多给。\n"
    "\n"
    "JSON 格式：\n"
    "{\n"
    '  "good": "做得好的一点（40字内）",\n'
    '  "notice": "值得注意的一点（40字内）",\n'
    '  "next_time": "如果再来一次的建议（40字内）",\n'
    '  "advantage": {"name": "优势标签（12字内）", "reason": "依据，含原话引用（30字内）"},\n'
    '  "weakness": {"name": "弱点标签（12字内）", "reason": "依据，含原话引用（30字内）"},\n'
    '  "alternative_action": "下次可以改用的具体动作（40字内）"\n'
    "}\n"
    '若某一项确实没有依据，对应值给 null。不要编造。'
)

# ─────────────────────────────────────────────────────────────
# v2.1 —— 修掉 v2 自己引入的回归
#
# 评测实测：v2 三个质量分全面优于 v1（具体性 +0.60、有依据 +0.37、可执行性 +0.52，
# 废话 −54%、错标 −56%），**但规则层通过率从 100% 掉到 96.7%**：
# arg-01 的 next_time 复盘块变成**空**。
#
# 原因是 v2 结尾那句「若某一项确实没有依据，对应值给 null。不要编造」——
# 它的**作用域外溢到了叙事块**。模型对没把握的内容一律给 null，
# 连「下次可以怎么改」都不写了。
# 用户打开复盘卡片看到一个空白栏，比看到一句平实的评价更糟。
#
# v2.1 只做一件事：把那条规则**限定在两条观察上**，三个叙事块反过来必须写。
# 这是一个**显式增量**而不是又抄一整份 prompt —— 差异一眼可见，
# 而且锚点失配时下面的 assert 会直接拦住，不会静默变成「v2.1 其实等于 v2」。
# ─────────────────────────────────────────────────────────────

_NULL_RULE_V2 = "若某一项确实没有依据，对应值给 null。不要编造。"

_NULL_RULE_V2_1 = (
    "【「给 null」只适用于两条观察】\n"
    "上面那句「没有依据就给 null」**只针对 weakness 和 advantage**。\n"
    "**good / notice / next_time 三个块必须有内容**，不许给 null、不许留空 ——"
    "用户打开复盘卡片看到空白栏，比看到一句平实的评价更糟。\n"
    "这三块写得朴素没关系，但不能空；「多注意」「要改进」这种也给不了用户任何东西。\n"
    "\n"
    "正例：\n"
    '  "good":      "第1轮先复述了对方观点再反驳，对方没有被打断的感觉"\n'
    '  "notice":    "被连续追问三轮后，回应从两句话缩到一句话"\n'
    '  "next_time": "被追问到第三次时，直接说「这点我还没想清楚」"\n'
    "\n"
    "反例（**不要**）：\n"
    '  "next_time": null       ← 空着最糟\n'
    '  "next_time": "以后多注意"  ← 有字但等于没说\n'
    "\n"
    "只有 weakness 和 advantage 在真的没有依据时才给 null。"
)

assert _NULL_RULE_V2 in _REVIEW_SYSTEM_V2, (
    "v2 的锚点变了 —— v2.1 的增量拼接会静默失效。请同步更新 _NULL_RULE_V2。"
)
_REVIEW_SYSTEM_V2_1 = _REVIEW_SYSTEM_V2.replace(_NULL_RULE_V2, _NULL_RULE_V2_1)

# 版本 → prompt。查表而不是 if/else，加版本时不会漏改分支。
_REVIEW_SYSTEMS = {
    "v1": _REVIEW_SYSTEM_V1,
    "v2": _REVIEW_SYSTEM_V2,
    "v2.1": _REVIEW_SYSTEM_V2_1,
}


def build_review_messages(
    topic: str,
    stance: str,
    transcript: str,
    context_blocks: str = "",
    *,
    level: str = "novice",
) -> list[ChatMessage]:
    """复盘卡片生成。

    严格限流：每场最多 1 条优势观察 + 1 条弱点观察 + 1 条替代动作。

    第二个位置参数是**用户档案上下文**（build_context_blocks 的产物），
    不是 build_stable_system 的产物——后者含辩论人格，会让模型继续辩论。
    """
    system = _REVIEW_SYSTEMS.get(REVIEW_PROMPT_VERSION, _REVIEW_SYSTEM_V2_1)
    user = (
        f"【辩题】{topic}\n【用户立场】{stance or '未声明'}\n"
        f"【对手风格】{_level_cn(level)}\n\n【辩论记录】\n{transcript}"
    )
    # 把用户档案并进同一条 system，而不是再插一条 system——
    # 两条 system 消息会让模型在「辩论对手」和「观察者」之间二选一。
    if context_blocks:
        system = f"{system}\n\n【用户档案】以下是这位用户已知的弱点与优势，供你判断时参考：\n{context_blocks}"

    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=user),
    ]


def build_event_scan_messages(cards_text: str, weaknesses: Sequence = ()) -> list[ChatMessage]:
    """事件卡扫描：从最近 7 天的事件卡里发现弱点候选。"""
    weak_hint = ""
    if weaknesses:
        names = "；".join(f"#{c.id} {c.name}" for c in sorted(weaknesses, key=lambda c: c.id))
        weak_hint = f"\n已存在的弱点（不要重复提出）：{names}"

    return [
        ChatMessage(
            role="system",
            content=(
                "你是「对镜」的模式识别器。阅读用户最近的事件卡，找出**跨场景重复出现**的行为模式。"
                "只输出 JSON，不要解释。\n"
                '格式：{"candidates": [{"name": "弱点标签（12字内）", '
                '"reason": "依据（40字内，引用具体事件）", "confidence": 1-5}]}\n'
                "最多 3 条。没有足够证据就返回空数组。不要为了凑数而编造。"
            ),
        ),
        ChatMessage(role="user", content=f"【最近事件卡】\n{cards_text}{weak_hint}"),
    ]


def build_loop_dialog_messages(
    weakness_name: str, step: str, collected: dict[str, str]
) -> list[ChatMessage]:
    """对话式回环启动。

    方案 3.3 把流程写死了四步，这里让模型基于已收集信息生成下一句追问，
    但问题主旨必须与规范一致。
    """
    guide = {
        "scene": "先请用户描述当时发生了什么。",
        "signal": "追问当时的身体感觉或情绪信号。",
        "plan": "追问下次遇到类似情况想怎么做。",
        "confirm": "把用户说的预案复述一遍，问是否现在启用。",
    }
    collected_text = "\n".join(f"- {k}：{v}" for k, v in collected.items() if v) or "（暂无）"

    return [
        ChatMessage(
            role="system",
            content=(
                "你是「对镜」的回环引导者。回环 = 弱点的一条 SOP，"
                "由「触发场景 + 身体信号 + 应对预案」三段组成。\n"
                "你一次只问一个问题，语气平实，不说教，不评价用户。\n"
                "只输出问题本身，不要加任何前后缀、不要编号、不要引号。"
            ),
        ),
        ChatMessage(
            role="user",
            content=(
                f"【当前弱点】{weakness_name}\n"
                f"【当前步骤】{step}（{guide.get(step, '')}）\n"
                f"【已收集】\n{collected_text}\n\n"
                "请输出这一轮要说的一句话。"
            ),
        ),
    ]


def build_alternative_action_messages(
    trigger_scene: str, action_plan: str, note: str
) -> list[ChatMessage]:
    """破功后给替代动作（方案 3.3）。"""
    return [
        ChatMessage(
            role="system",
            content=(
                "用户的一次演练破功了。给一个比原预案更容易执行的具体替代动作。"
                "要求：只输出这一句话，不超过 40 字，必须是一个可以当场做的动作，"
                "不要安慰，不要说教，不要重复原预案。"
            ),
        ),
        ChatMessage(
            role="user",
            content=(
                f"【触发场景】{trigger_scene}\n"
                f"【原预案】{action_plan}\n"
                f"【这次发生了什么】{note or '（用户未填写）'}"
            ),
        ),
    ]


def build_event_card_analysis_messages(
    content: str, loops: Sequence, weaknesses: Sequence = ()
) -> list[ChatMessage]:
    """事件卡判定：极简模式下由 AI 判断关联哪个回环、结果是什么。

    方案 3.4：只写一句时，AI 自动判断关联和结果；不确定时标记「待确认」。
    """
    loop_lines = []
    for loop in sorted(loops, key=lambda lp: lp.id):
        weakness_name = ""
        for card in weaknesses:
            if card.id == loop.weakness_id:
                weakness_name = card.name
                break
        loop_lines.append(
            f"- #{loop.id} 场景：{loop.trigger_scene}"
            + (f"｜对应弱点：{weakness_name}" if weakness_name else "")
            + (f"｜预案：{loop.action_plan}" if loop.action_plan else "")
        )
    loop_block = "\n".join(loop_lines) if loop_lines else "（用户当前没有启用中的回环）"

    return [
        ChatMessage(
            role="system",
            content=(
                "你在帮用户给一条实战记录归档。判断两件事：\n"
                "1. 这条记录最接近哪个回环（如果都不接近，给 null）\n"
                "2. 用户当时是撑住了（hold）、破功了（break）、还是那个场景根本没出现"
                "（not_triggered）；判断不了就给 unsure\n"
                "只输出 JSON，不要解释。\n"
                '格式：{"loop_id": 数字或null, "result": "hold|break|not_triggered|unsure", '
                '"reason": "20字内依据"}\n'
                "拿不准就老实给 unsure 和 null，不要猜。"
            ),
        ),
        ChatMessage(
            role="user",
            content=f"【用户记录】{content}\n\n【可选回环】\n{loop_block}",
        ),
    ]


def build_principle_messages(loop_desc: str, logs_text: str) -> list[ChatMessage]:
    """撑住率达标后提炼原则候选。"""
    return [
        ChatMessage(
            role="system",
            content=(
                "用户在某个回环上连续撑住了。从他实际做对的动作里提炼一条可复用的原则。"
                "只输出 JSON，不要解释。\n"
                '格式：{"content": "原则（25字内，祈使句，可直接执行）"}\n'
                "要求：必须是用户已经验证过的做法，不要发明新方法。"
            ),
        ),
        ChatMessage(role="user", content=f"【回环】\n{loop_desc}\n\n【演练记录】\n{logs_text}"),
    ]


# ─────────────────────────────────────────────────────────────
# 内部小工具
# ─────────────────────────────────────────────────────────────


def _level_cn(level: str) -> str:
    return {
        "novice": "新手（温和，多给台阶）",
        "intermediate": "中级（正常对抗）",
        "advanced": "高级（犀利，直击薄弱处）",
    }.get(level, "新手（温和，多给台阶）")


def _weakness_status_cn(status: str) -> str:
    return {
        "ai_candidate": "AI 观察候选",
        "observing": "观察中",
        "improving": "改善中",
        "archived": "暂存",
    }.get(status, status)
