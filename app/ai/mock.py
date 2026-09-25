"""对镜 · Mock Provider

作用：在没有 API Key 的情况下，让「辩论房 → 复盘 → 观察 → 弱点 → 回环 → 演练」
整条链路可以真实跑通、可以演示、可以做端到端测试。

它不是随机字符串生成器——每个任务的输出都遵守对应 Prompt 的结构约定
（结构化任务输出合法 JSON），因此业务层的解析、校验、落库逻辑
在 Mock 和真实模型下走的是同一条代码路径。

真实模型接入后，这个 Provider 仍然有用：单元测试和 CI 都靠它避免联网。
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from collections.abc import AsyncIterator

from app.ai.base import AIResponse, AIUsage, BaseProvider, ChatMessage

# 流式输出的模拟节奏（秒/块）。测试里设成 0 可以跑得飞快。
STREAM_CHUNK_SIZE = 4
STREAM_DELAY = 0.02


# ─────────────────────────────────────────────────────────────
# 辩论房
# ─────────────────────────────────────────────────────────────

_OPENER_TEMPLATES = [
    "先亮我的立场：{against}。你可能会说{quote}，但这句话预设了一个未经检验的前提。"
    "我想先问一句——你说的这件事，有没有过一次例外？那次发生了什么？",
    "我站{against}。你的说法听起来成立，是因为它只挑了对你自己有利的那种情形。"
    "换一个场景还成立吗？请举一个你自己身上、不符合这个判断的例子。",
    "{against}——这是我的立场。在展开之前我想确认一件事："
    "你现在这个判断，是来自亲身经历，还是来自你觉得「应该如此」？",
]

_COUNTER_TEMPLATES = [
    "你说{quote}——请注意，这句话里藏着一个跳跃：从「发生过」直接推到「总是会」。"
    "中间那一步你没有给。补上它。",
    "{quote}，这确实是一种解释。但同样的事实还有另一种解释："
    "你之所以这么看，是因为你只在这个位置上待过。你怎么排除这种可能？",
    "我不否认{quote}这个事实，我否认的是它支撑得起你的结论。"
    "你举的是一个例子，不是一条规律。还有第二个例子吗？",
    "到这里你换了一个说法。前面你说的是{quote}，现在说的是另一件事。"
    "这两个是同一个论点，还是你已经悄悄把论题改小了？",
    "你刚才的回应里，「{quote}」这几个字重复了两次。"
    "我好奇的是，如果我完全不接受这一条，你手上还剩什么？",
]

_PRESSURE_TEMPLATES = [
    "我换个问法，这次请只回答是或不是：{quote}，这是你真实的判断，还是你希望它是真的？",
    "我们先把情绪放一边。你连着两轮都在解释动机，但没有回答我的问题。"
    "问题是：{quote}的反例存在吗？",
    "你开始重复自己了。这通常意味着论点已经到底。"
    "要么给我一个新证据，要么承认{quote}这一条你没法 defend。",
]

_CLOSING_TEMPLATES = [
    "时间差不多了，我总结一下我们的分歧：你认为{quote}，"
    "而我认为这个判断缺少一个必要条件。这个条件你想清楚了吗？",
    "最后一轮。撇开输赢，你今天守住的是哪一条？"
    "如果只能留一句话给下次的自己，会是哪一句？",
]

_AGAINST_TEMPLATES = [
    "反方",
    "对立面",
    "另一边",
]


def _quote(text: str, limit: int = 14) -> str:
    """从用户发言里摘一小段做引用，让模拟回复看起来是「接住了话」。"""
    cleaned = re.sub(r"\s+", "", text or "")
    cleaned = cleaned.strip("。！？，、；：""''（）")
    if not cleaned:
        return "你说的那一点"
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit]


def _pick(seq: list[str], seed: str) -> str:
    return random.Random(seed).choice(seq)


def _opening_reply(user_prompt: str, seed: str) -> str:
    quote = "这件事应该直接说清楚"
    match = re.search(r"【用户立场】(.+)", user_prompt)
    if match:
        stance = match.group(1).strip()
        if stance and stance != "未声明":
            quote = _quote(stance, 12)
    against = _pick(_AGAINST_TEMPLATES, seed)
    return _pick(_OPENER_TEMPLATES, seed).format(against=against, quote=quote)


def _debate_reply(user_text: str, history_len: int, seed: str, has_loop: bool) -> str:
    quote = _quote(user_text)
    if history_len >= 6:
        template = _pick(_CLOSING_TEMPLATES, seed)
    elif history_len >= 4:
        template = _pick(_PRESSURE_TEMPLATES, seed)
    else:
        template = _pick(_COUNTER_TEMPLATES, seed)
    body = template.format(quote=quote)

    # 关联回环时，模拟 AI「故意制造触发场景但不告知用户」
    if has_loop and history_len == 2:
        body += "换个场景问你：如果这次不是私下聊，而是在一群人面前被当场问到，你的回答会变吗？"
    return body


# ─────────────────────────────────────────────────────────────
# 结构化任务
# ─────────────────────────────────────────────────────────────


def _topic_json(user_prompt: str, seed: str) -> str:
    match = re.search(r"场景：(.+)", user_prompt)
    scene = _quote(match.group(1).strip(), 24) if match else "这件事"

    topic = _pick(
        [
            f"面对「{scene}」，应该当场表态还是先按兵不动",
            f"「{scene}」这件事，问题出在做法还是出在判断",
            f"遇到「{scene}」时，是改变对方还是调整自己",
        ],
        seed,
    )
    stance = _pick(
        ["应该当场把话说清楚", "问题主要出在判断上", "应该先调整自己的应对"],
        seed + "s",
    )
    return json.dumps({"topic": topic, "stance": stance}, ensure_ascii=False)


def _review_json(transcript: str, seed: str) -> str:
    """复盘卡片。

    严格产出：1 条优势 + 1 条弱点 + 1 条替代动作（方案第九章第 5 条）。
    """
    user_lines = [
        line for line in transcript.splitlines() if line.startswith("用户：")
    ]
    turns = len(user_lines)
    last_user = _quote(user_lines[-1].replace("用户：", ""), 18) if user_lines else "你的观点"

    rng = random.Random(seed)

    good_pool = [
        f"你主动给出了具体例子（「{last_user}」），没有停在抽象判断上",
        "被连续追问后你没有回避，仍然在正面回应问题",
        "你会回头修自己的措辞，说明在检查论证是否站得住",
        "你在后半程开始提问，而不是只做防守",
    ]
    notice_pool = [
        f"被追问到第三次时，你用「{last_user}」重复了前面的说法，没有补充新证据",
        "对方连续施压后，你的回应开始变短，论证密度下降",
        "你两次把话题从「事实」移到「动机」，回避了正面交锋",
        "你倾向于用类比代替论证，但类比本身没有被验证",
    ]
    next_pool = [
        "下次先复述对方的问题再回答，能给自己 3 秒组织证据",
        "准备一个你自己身上的反例，被追问时直接用",
        "把结论拆成「事实」和「判断」两层说，对方就很难偷换",
        "被问到第三次时，直接说「这点我还没想清楚」，比硬撑更有力",
    ]
    alt_pool = [
        "下次被追问时，先说「这点我还没想清楚」，再补一条事实",
        "对方施压时，先复述一遍他的问题，再回答",
        "每轮发言前先写一句结论，再写两条支撑",
        "遇到类比式反驳，先问对方「这个类比在哪儿不成立」",
    ]
    adv_pool = [
        ("临场反应快", "被追问后能立刻给出回应，没有长时间停顿"),
        ("愿意修正措辞", "会回头检查自己的表述是否准确"),
        ("有具体经验支撑", "论证时能调用真实经历而不是空谈"),
    ]
    weak_pool = [
        ("被追问时防御性重复", "压力下重复原话，不补充新证据"),
        ("用动机替代论证", "被质疑时转向解释自己的动机"),
        ("回避正面交锋", "连续施压后转移话题"),
    ]

    advantage = rng.choice(adv_pool)
    weakness = rng.choice(weak_pool)

    payload = {
        "good": rng.choice(good_pool),
        "notice": rng.choice(notice_pool),
        "next_time": rng.choice(next_pool),
        "advantage": {"name": advantage[0], "reason": advantage[1]},
        "weakness": {"name": weakness[0], "reason": weakness[1]},
        "alternative_action": rng.choice(alt_pool),
    }
    if turns < 2:
        # 记录太少时不给观察，避免编造
        payload["advantage"] = None
        payload["weakness"] = None
    return json.dumps(payload, ensure_ascii=False)


def _scan_json(user_prompt: str, seed: str) -> str:
    rng = random.Random(seed)
    count = user_prompt.count("\n- ")
    pool = [
        ("被追问时防御性重复", "多条记录里都出现了被追问后重复原话的情况", 4),
        ("计划外变化容易焦躁", "两次提到计划被打乱后的情绪反应", 3),
        ("对否定反馈反应过度", "记录中出现收到负面评价后的强烈措辞", 3),
    ]
    if count < 3:
        return json.dumps({"candidates": []}, ensure_ascii=False)
    rng.shuffle(pool)
    picked = pool[: min(2, len(pool))]
    return json.dumps(
        {
            "candidates": [
                {"name": name, "reason": reason, "confidence": conf}
                for name, reason, conf in picked
            ]
        },
        ensure_ascii=False,
    )


_LOOP_QUESTIONS = {
    "scene": "你刚才说「{weakness}」，能说说最近一次具体发生了什么吗？当时是什么场合、有谁在？",
    "signal": "当时身体上有什么感觉？比如心跳、呼吸、或者手上在做什么动作。",
    "plan": "下次再遇到类似情况，你想怎么做？说一个具体的动作，不要只说要冷静。",
    "confirm": "好，这就是你的预案。要现在启用吗？",
}


def _loop_question(user_prompt: str) -> str:
    match = re.search(r"【当前步骤】(\w+)", user_prompt)
    step = match.group(1) if match else "scene"

    name_match = re.search(r"【当前弱点】(.+)", user_prompt)
    weakness = name_match.group(1).strip() if name_match else "这件事"

    template = _LOOP_QUESTIONS.get(step, _LOOP_QUESTIONS["scene"])
    return template.format(weakness=weakness)


def _alternative_action(user_prompt: str, seed: str) -> str:
    rng = random.Random(seed)
    return rng.choice(
        [
            "下次被追问时，先重复一遍对方的问题，再开口回答",
            "感觉要重复自己的时候，停下来问一句「你具体想确认哪一点」",
            "开口前先在心里把结论压到 15 字以内，再说细节",
            "被否定时先记下来，隔 10 分钟再回应",
        ]
    )


def _principle_json(user_prompt: str, seed: str) -> str:
    rng = random.Random(seed)
    return json.dumps(
        {
            "content": rng.choice(
                [
                    "先承认没想清楚，再补充事实",
                    "被追问时先复述问题，再回答",
                    "结论先行，证据在后",
                    "情绪上来时先记录，不急着回应",
                ]
            )
        },
        ensure_ascii=False,
    )


# ─────────────────────────────────────────────────────────────
# Provider
# ─────────────────────────────────────────────────────────────


class MockProvider(BaseProvider):
    name = "mock"
    default_model = "mock-v1"

    def __init__(self, stream_delay: float = STREAM_DELAY) -> None:
        super().__init__(api_key="mock", base_url="mock://local", model=self.default_model)
        self.stream_delay = stream_delay

    @property
    def configured(self) -> bool:
        return True

    # ── 任务识别 ──────────────────────────────────────────

    def _generate(self, messages: list[ChatMessage]) -> str:
        sys_text = "\n".join(m.content for m in messages if m.role == "system")
        user_msgs = [m.content for m in messages if m.role == "user"]
        user_prompt = user_msgs[-1] if user_msgs else ""
        history = [m for m in messages if m.role in ("user", "assistant")]

        seed = f"{len(sys_text)}-{len(user_prompt)}-{user_prompt[:64]}"

        if "辩题设计者" in sys_text:
            return _topic_json(user_prompt, seed)

        if "辩论观察者" in sys_text:
            transcript = _extract_transcript(user_prompt)
            return _review_json(transcript, seed)

        if "模式识别器" in sys_text:
            return _scan_json(user_prompt, seed)

        if "回环引导者" in sys_text:
            return _loop_question(user_prompt)

        if "替代动作" in sys_text:
            return _alternative_action(user_prompt, seed)

        if "提炼一条可复用的原则" in sys_text:
            return _principle_json(user_prompt, seed)

        if "辩论对手兼观察者" in sys_text:
            has_loop = "本场未关联回环" not in sys_text
            if "开场立论" in user_prompt:
                return _opening_reply(user_prompt, seed)
            return _debate_reply(user_prompt, len(history), seed, has_loop)

        # 兜底：不至于让调用方拿到空串
        return "（模拟回复）我暂时没有更多补充。"

    # ── 协议实现 ──────────────────────────────────────────

    async def _complete_impl(self, messages, *, model, temperature, max_tokens) -> AIResponse:
        text = self._generate(messages)
        prompt_chars = sum(len(m.content) for m in messages)
        return AIResponse(
            text=text,
            usage=AIUsage(
                # 粗略按 1 token ≈ 1.6 汉字估算，只为让成本面板有数可看
                prompt_tokens=int(prompt_chars / 1.6),
                completion_tokens=int(len(text) / 1.6),
                cached_tokens=int(prompt_chars / 1.6) if len(messages) > 1 else 0,
                model=model or self.default_model,
            ),
            provider=self.name,
        )

    async def _stream_impl(self, messages, *, model, temperature, max_tokens) -> AsyncIterator[str]:
        text = self._generate(messages)
        for index in range(0, len(text), STREAM_CHUNK_SIZE):
            if self.stream_delay:
                await asyncio.sleep(self.stream_delay)
            yield text[index : index + STREAM_CHUNK_SIZE]


def _extract_transcript(user_prompt: str) -> str:
    marker = "【辩论记录】"
    if marker in user_prompt:
        return user_prompt.split(marker, 1)[1].strip()
    return user_prompt
