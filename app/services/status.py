"""对镜 · 状态栏（首页四块）

方案 3.7 的规则，逐条落实：
  · 今天练什么 → 最多 2 条回环
  · 精力/心情可跳过，不填不显示
  · AI 观察候选 24 小时从首次看到算
  · 空状态各块自行收形
方案第九章第 6 条：状态栏只做轻操作——不能写日记、建原则、开辩论。
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DailyState,
    DebateRoom,
    EventCard,
    LoopLog,
    LoopStatus,
    User,
    WeaknessCard,
    WeaknessLoop,
)
from app.services import observations as observation_service
from app.services.loops import loop_stats, loop_trends
from app.utils import iso_utc, local_today, weekday_cn

TODAY_LOOPS_LIMIT = 2
LOOKBACK_DAYS = 400


async def compute_streak(session: AsyncSession, user_id: int) -> int:
    """连续天数。

    定义（已与产品确认）：**当天有实战记录就算**——
    即当天写过事件卡，或写过任一演练日志（loop_log）。

    今天还没记录时，从昨天往前数：这样用户白天打开 App
    不会看到连续天数突然归零。
    """
    since = local_today() - timedelta(days=LOOKBACK_DAYS)

    log_dates = await session.execute(
        select(LoopLog.date).where(LoopLog.user_id == user_id, LoopLog.date >= since).distinct()
    )
    card_dates = await session.execute(
        select(EventCard.created_at).where(EventCard.user_id == user_id)
    )

    active_days: set = {row[0] for row in log_dates.all()}
    for (created_at,) in card_dates.all():
        if created_at is not None:
            from app.utils import utc_to_local

            local = utc_to_local(created_at)
            if local and local.date() >= since:
                active_days.add(local.date())

    if not active_days:
        return 0

    today = local_today()
    cursor = today if today in active_days else today - timedelta(days=1)

    streak = 0
    while cursor in active_days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


async def get_today_state(session: AsyncSession, user_id: int) -> DailyState | None:
    return await session.scalar(
        select(DailyState).where(
            DailyState.user_id == user_id, DailyState.date == local_today()
        )
    )


async def get_today_loops(session: AsyncSession, user_id: int) -> list[dict]:
    """今天练什么：启用中的回环，最多 2 条。

    排序按撑住率升序——最该练的排最前。
    """
    rows = await session.execute(
        select(WeaknessLoop, WeaknessCard)
        .join(WeaknessCard, WeaknessLoop.weakness_id == WeaknessCard.id)
        .where(
            WeaknessCard.user_id == user_id,
            # 含 needs_revision：破功后回环进入待修订，那恰恰是最该被看见的时刻，
            # 如果这时把它从首页拿掉，用户第二天打开 App 会发现"没什么可练的"。
            # 不含 paused：方案 3.3 明确"暂停后不推送演练"。
            WeaknessLoop.status.in_(
                (LoopStatus.ACTIVE.value, LoopStatus.NEEDS_REVISION.value)
            ),
            WeaknessCard.status != "archived",
        )
    )
    pairs = rows.all()
    if not pairs:
        return []

    loop_ids = [loop.id for loop, _ in pairs]
    stats = await loop_stats(session, loop_ids)
    trends = await loop_trends(session, loop_ids)

    items = []
    for loop, weakness in pairs:
        st = stats.get(loop.id)
        rate = st.rate if st else None
        trend = trends.get(loop.id)
        items.append(
            {
                "loop_id": loop.id,
                "weakness_id": weakness.id,
                "title": (loop.action_plan or loop.trigger_scene or weakness.name)[:60],
                "weakness_name": weakness.name,
                "hold_rate_30d": rate,
                "trigger_count_30d": st.trigger_count if st else 0,
                "rate_bucket": st.bucket if st else None,
                "hold_rate_7d": trend.rate_7d if trend else None,
                "hold_rate_prev_7d": trend.rate_prev_7d if trend else None,
                "trend_delta": trend.delta if trend else None,
            }
        )

    # 还没有数据的回环排最前：对新建回环的用户来说，
    # 它是唯一一条，必须出现；对老用户来说，未练过的回环也是待办。
    # 其余按撑住率升序——最该练的排最前。
    items.sort(key=lambda item: (
        -1 if item["hold_rate_30d"] is None else item["hold_rate_30d"],
        item["loop_id"],
    ))
    return items[:TODAY_LOOPS_LIMIT]


async def has_any_activity(session: AsyncSession, user_id: int) -> bool:
    """用户是否**做过任何事**。

    用来决定首页要不要显示底部的全局快捷按钮。

    为什么不能只看两张卡片是否为空：记录一张事件卡既不建回环、
    也不立即产生 AI 观察（它先进队列，等夜间扫描），所以「记了几笔」
    的用户在首页上看起来仍像全新的——那显然不对，他已经开始用了。

    这里查的是「有没有留下过任何痕迹」：事件卡、辩论、弱点、演练日志。
    """
    for model in (EventCard, DebateRoom, WeaknessCard, LoopLog):
        found = await session.scalar(
            select(model.id).where(model.user_id == user_id).limit(1)
        )
        if found is not None:
            return True
    return False


# ─────────────────────────────────────────────────────────────
# 「过去的你」—— 首次记录 vs 最近一周
#
# 【为什么要有它】
#
# 产品收到的第二个真实反馈是：**没有锚点，用户不知道每天来干嘛。**
# 「今天练什么」「AI 观察」都是**当下**的东西，而改善弱点这件事
# 反人性、很累，指望用户为了「改掉缺点」天天打卡是不现实的。
#
# 唯一能持续拽住人的，是「我真的在变」的实感。
# 而这个实感不能靠一句安慰，得靠**可对照的数字**：同一类场景，
# 三个月前的你 vs 现在的你。
#
# 【为什么窗口是「首次 7 天」vs「最近 7 天」，而不是 30 天 vs 30 天】
#
# 这个产品用户量小、记录稀疏。30 天窗口对大多数人在早期是个空集，
# 功能会永远不出现。7 天窗口能更早给出第一个有意义的对比，
# 代价是噪声更大 —— 所以下面要求两侧都至少 2 次触发，且**不评判好坏**，
# 只把两个数字并排摆出来（文案见前端）。
# ─────────────────────────────────────────────────────────────

# 对比区最少需要几次触发。低于这个数就不显示 —— 1 次撑住 / 1 次破功
# 得出的「撑住率 100% / 0%」不是趋势，是噪声。
PAST_YOU_MIN_LOGS = 2
PAST_YOU_WINDOW_DAYS = 7


async def get_past_you(session: AsyncSession, user_id: int) -> dict | None:
    """返回「过去的你」对比数据；数据不足时返回 None（前端整块不渲染）。"""
    rows = (
        await session.execute(
            select(LoopLog.date, LoopLog.result).where(
                LoopLog.user_id == user_id,
                # not_triggered 不进撑住率：它表示「今天没遇到这个场景」，
                # 既不是撑住也不是破功，算进去会把比率稀释成假的数字。
                LoopLog.result.in_(("hold", "break")),
            )
        )
    ).all()
    if not rows:
        return None

    today = local_today()
    first_date = min(date for date, _ in rows)

    # 首次窗口和最近窗口如果重叠，说明用户几乎没历史，
    # 两边比的是同一批数据 —— 那种「对比」是假的，不要显示。
    if (today - first_date).days < PAST_YOU_WINDOW_DAYS:
        return None

    early_end = first_date + timedelta(days=PAST_YOU_WINDOW_DAYS - 1)
    recent_start = today - timedelta(days=PAST_YOU_WINDOW_DAYS - 1)

    early = [(date, result) for date, result in rows if first_date <= date <= early_end]
    recent = [(date, result) for date, result in rows if recent_start <= date <= today]

    if len(early) < PAST_YOU_MIN_LOGS or len(recent) < PAST_YOU_MIN_LOGS:
        return None

    def rate(pairs) -> int:
        holds = sum(1 for _, result in pairs if result == "hold")
        return round(holds * 100 / len(pairs))

    return {
        "days_ago": (today - first_date).days,
        "first_date": first_date.isoformat(),
        "early_rate": rate(early),
        "early_total": len(early),
        "recent_rate": rate(recent),
        "recent_total": len(recent),
    }


# 问候语。
#
# 【为什么是规则生成，不是每天调一次 AI】
#
# 首页首屏是产品最重要的 300 毫秒。为了一句问候语在 GET /status-bar 里
# 同步调模型，首屏会多 1–3 秒 —— 那是拿最重要的体验换一句话。
# 走异步队列又要多一张表 + 一个调度任务，只为了每天一句。
#
# 而下面这些句子需要的信息（昨天有没有撑住、有没有写过事件卡、连续几天）
# 全都在库里，规则能说得比模型更准 —— 模型看不到那些记录，
# 写出来的「温暖」只能是泛泛的安慰，那正是这个产品最不想要的空洞感。
#
# 所以：**这是这个产品自己的声音，不假装是 AI 说的。**
GREETINGS = {
    "hold": "昨天你记的那一笔，你撑住了。那一天你是清醒的。",
    "break": "昨天那次没撑住。但你把它记下来了 —— 记住的那一刻，它就不再是盲区了。",
    "card": "你写下的那些瞬间还在，等你回来看。",
    "pending": "有件事我观察了一阵子，想问问你怎么看。",
    "streak": "第 {n} 天了。不用每天都做得很好，来就够了。",
    "returning": "今天想从哪儿开始都行，没人催你。",
    "fresh": "慢慢来。这里只有你自己，写错了也没人看见。",
}


async def get_greeting(
    session: AsyncSession,
    user_id: int,
    *,
    streak: int,
    has_pending_observation: bool,
    is_fresh: bool,
) -> str:
    """首页的一句问候。**没有 AI 调用**，纯规则，理由见上面那段说明。"""
    if is_fresh:
        return GREETINGS["fresh"]

    yesterday = local_today() - timedelta(days=1)
    results = [
        row[0]
        for row in (
            await session.execute(
                select(LoopLog.result).where(
                    LoopLog.user_id == user_id,
                    LoopLog.date == yesterday,
                    LoopLog.result.in_(("hold", "break")),
                )
            )
        ).all()
    ]
    if "hold" in results:
        return GREETINGS["hold"]
    if "break" in results:
        return GREETINGS["break"]
    if has_pending_observation:
        return GREETINGS["pending"]

    has_card = await session.scalar(
        select(EventCard.id).where(EventCard.user_id == user_id).limit(1)
    )
    if has_card is not None:
        return GREETINGS["card"]

    if streak >= 3:
        return GREETINGS["streak"].format(n=streak)
    return GREETINGS["returning"]


async def build_status_bar(session: AsyncSession, user: User) -> dict:
    """组装首页四块。"""
    today = local_today()

    state = await get_today_state(session, user.id)
    streak = await compute_streak(session, user.id)
    loops = await get_today_loops(session, user.id)

    # 首页展示 AI 观察候选时，同时开始 24 小时倒计时
    pending = await observation_service.list_pending(session, user.id, limit=1, mark_seen=True)

    # 首页的「全新用户」判定：两张卡片都空，且从没做过任何事。
    # 前端据此决定是否隐藏底部的全局快捷按钮，让新用户只面对两个明确行动。
    fresh = not loops and not pending and not await has_any_activity(session, user.id)

    greeting = await get_greeting(
        session,
        user.id,
        streak=streak,
        has_pending_observation=bool(pending),
        is_fresh=fresh,
    )
    past_you = await get_past_you(session, user.id)

    return {
        "date": today.isoformat(),
        "weekday": weekday_cn(today),
        "energy": state.energy if state else None,
        "mood": state.mood if state else None,
        "streak_days": streak,
        "is_fresh_start": fresh,
        # 一句问候：让首页先像个人说话，再像看板给数据（见 get_greeting 说明）
        "greeting": greeting,
        # 「过去的你」：首次记录 vs 最近一周的撑住率对比；数据不足时为 null
        "past_you": past_you,
        "today_loops": loops,
        "observations": [
            {
                "id": obs.id,
                "type": obs.type,
                "content": obs.content,
                "created_at": iso_utc(obs.created_at),
            }
            for obs in pending
        ],
    }
