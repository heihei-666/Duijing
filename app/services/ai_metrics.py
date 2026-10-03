"""对镜 · AI 调用度量

这个模块回答三个此前**无法回答**的问题：

    1. 每次模型调用花了多少 token？缓存命中多少？省了多少钱？
    2. 两家的延迟、失败率各是多少？路由对不对？
    3. 流式的首 token 延迟（TTFT）是多少？

为什么值得单独一个模块：这三个问题的数据其实**一直都有** ——
provider 层认真采集了 `prompt_cache_hit_tokens`，但此前没有任何读取方，
采完就丢。这个项目主打的三个技术点（多模型路由、前缀缓存、SSE 流式）
因此全都无法自证，面试时只能答「我用了 X」而不是「数据是 Y」。

【为什么不直接写数据库】

SQLite 的写锁是**全局**的，而 AI 调用经常发生在「请求事务已经 flush、
还没 commit」的中间态（例如建辩论：先 add room + flush，再调模型生成开场白）。
这时候用另一个连接去写 `ai_call_log`，会撞上 `busy_timeout`，
轻则拖慢 5 秒，重则直接失败。

所以这里用**内存缓冲 + 定时落库**：
  · `record_ai_call()` 只往内存里 append，永不阻塞、永不失败
  · DataFrame `flush_to_db()` 由定时任务每分钟调用一次，在**没有请求事务**的时刻批量写
  · 副作用是进程崩溃时会丢掉最多 1 分钟的记录 —— 对观测数据可以接受

`metrics.py` 里 SSE 计数用的是同一套思路（进程内计数 + 定期暴露）。
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass, field

logger = logging.getLogger("duijing.ai_metrics")

# 缓冲上限。超过就丢最旧的 —— 观测数据不该把内存撑爆，
# 出现这种情况本身说明落库任务卡住了，`snapshot()` 里的 dropped 会暴露它。
_BUFFER_MAX = 5000

_buffer: deque[dict] = deque(maxlen=_BUFFER_MAX)
_lock = threading.Lock()

# 当前请求的用户 id。由 `deps.get_current_user` 写入。
#
# 用 ContextVar 而不是模块变量：它跟着请求的上下文走，
# 而依赖与端点函数运行在**同一个** task 上下文里，所以读得到；
# 定时任务里没人设置它，取到 None 也是对的。
_current_user_id: ContextVar[int | None] = ContextVar("dj_ai_user_id", default=None)


def set_current_user_id(user_id: int | None) -> None:
    _current_user_id.set(user_id)


def current_user_id() -> int | None:
    return _current_user_id.get()


# ── 价格表（元 / 百万 token） ──────────────────────────────────
#
# 取自方案 5.1 的定价表。**注意口径**：
# DeepSeek 官方文档目前给的缓存命中价是 0.1 元/M、未命中 1 元/M，
# 与方案里写的 0.02 元/M 不一致。这里沿用方案的数字（它是本项目的
# 既定假设），但把它**暴露在 API 响应里**，这样任何人算出来的成本
# 都能对着价格表复核，而不是看到一个来路不明的数字。
#
# 改动价格请同时改这里和 README，不要让成本数字变成不可追溯的传说。
PRICES: dict[str, dict[str, float]] = {
    "deepseek": {"cached_input": 0.02, "input": 1.0, "output": 4.0},
    "mimo": {"cached_input": 0.02, "input": 1.0, "output": 2.0},
}
_UNKNOWN_PRICE = {"cached_input": 0.0, "input": 0.0, "output": 0.0}


@dataclass(slots=True)
class Totals:
    calls: int = 0
    errors: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    cost_yuan: float = 0.0

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "errors": self.errors,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cached_tokens": self.cached_tokens,
            "cost_yuan": round(self.cost_yuan, 6),
        }


def estimate_cost(
    provider: str, *, prompt_tokens: int, cached_tokens: int, completion_tokens: int
) -> float:
    """按价格表估算一次调用的成本（元）。

    未命中的输入 = 总输入 − 命中部分（命中部分按缓存价算）。
    """
    price = PRICES.get(provider, _UNKNOWN_PRICE)
    uncached = max(0, prompt_tokens - cached_tokens)
    return (
        uncached / 1_000_000 * price["input"]
        + cached_tokens / 1_000_000 * price["cached_input"]
        + completion_tokens / 1_000_000 * price["output"]
    )


def record_ai_call(
    *,
    task: str,
    provider: str,
    model: str = "",
    prompt_version: str = "",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    cached_tokens: int = 0,
    latency_ms: int = 0,
    ttft_ms: int | None = None,
    status: str = "ok",
    error: str | None = None,
    streamed: bool = False,
    user_id: int | None = None,
) -> None:
    """记一次调用。**本函数永不抛异常、永不阻塞** —— 观测不能反过来搞挂业务。"""
    try:
        entry = {
            "user_id": current_user_id() if user_id is None else user_id,
            "task": task,
            "provider": provider,
            "model": model,
            "prompt_version": prompt_version,
            "prompt_tokens": int(prompt_tokens or 0),
            "completion_tokens": int(completion_tokens or 0),
            "cached_tokens": int(cached_tokens or 0),
            "latency_ms": int(latency_ms or 0),
            "ttft_ms": ttft_ms,
            "status": status,
            "error": (error or None) and str(error)[:500],
            "streamed": bool(streamed),
        }
        with _lock:
            # deque(maxlen=...) 会静默丢掉最旧的，所以自己先数一下 ——
            # 「开始丢观测数据了」本身是要被看见的信号。
            if len(_buffer) >= _BUFFER_MAX:
                _totals.dropped += 1
            _buffer.append(entry)
        _totals.merge(entry)
    except Exception:  # noqa: BLE001
        logger.exception("AI 调用记录失败（不影响业务）")


@dataclass
class _Totals:
    """进程启动以来的累计值（进程重启会归零；历史值在 ai_call_log 表里）。"""

    calls: int = 0
    errors: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    cost_yuan: float = 0.0
    dropped: int = 0
    by_provider: dict[str, int] = field(default_factory=dict)
    by_task: dict[str, int] = field(default_factory=dict)
    latencies: deque[int] = field(default_factory=lambda: deque(maxlen=500))

    def merge(self, entry: dict) -> None:
        self.calls += 1
        if entry["status"] != "ok":
            self.errors += 1
        self.prompt_tokens += entry["prompt_tokens"]
        self.completion_tokens += entry["completion_tokens"]
        self.cached_tokens += entry["cached_tokens"]
        self.cost_yuan += estimate_cost(
            entry["provider"],
            prompt_tokens=entry["prompt_tokens"],
            cached_tokens=entry["cached_tokens"],
            completion_tokens=entry["completion_tokens"],
        )
        self.by_provider[entry["provider"]] = self.by_provider.get(entry["provider"], 0) + 1
        self.by_task[entry["task"]] = self.by_task.get(entry["task"], 0) + 1
        if entry["latency_ms"]:
            self.latencies.append(entry["latency_ms"])


_totals = _Totals()


def _percentile(values: list[int], pct: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(pct / 100 * (len(ordered) - 1)))))
    return ordered[index]


def snapshot() -> dict:
    """给 `/api/admin/ai-stats` 用的进程内汇总（不需要查库）。"""
    cached = _totals.cached_tokens
    prompt = _totals.prompt_tokens
    return {
        "since": "process-start",
        "calls": _totals.calls,
        "errors": _totals.errors,
        "error_rate": (round(_totals.errors / _totals.calls, 4) if _totals.calls else None),
        "prompt_tokens": prompt,
        "completion_tokens": _totals.completion_tokens,
        "cached_tokens": cached,
        # 这是「我用了前缀缓存」变成「命中率 X%」的那一个数字
        "cache_hit_rate": (round(cached / prompt, 4) if prompt else None),
        "cost_yuan": round(_totals.cost_yuan, 6),
        "latency_ms_p50": _percentile(list(_totals.latencies), 50),
        "latency_ms_p95": _percentile(list(_totals.latencies), 95),
        "by_provider": dict(_totals.by_provider),
        "by_task": dict(_totals.by_task),
        "buffered": len(_buffer),
        "dropped": _totals.dropped,
    }


def pending_count() -> int:
    with _lock:
        return len(_buffer)


def reset_for_tests() -> None:
    """把进程内计数清零。

    **只给测试用。** 生产代码不该调它 —— 累计值归零会让 `/api/admin/ai-stats`
    的 `live` 段看起来像「服务刚重启」，从而掩盖真实的调用量。
    命名为 `_for_tests` 就是为了让它在 review 时一眼被看见。
    """
    with _lock:
        _buffer.clear()
        _totals.__init__()  # type: ignore[misc]


def drain() -> list[dict]:
    """取走缓冲里的全部记录。"""
    with _lock:
        items = list(_buffer)
        _buffer.clear()
    return items


def restore(items: list[dict]) -> None:
    """落库失败时把记录放回去，下次再试（最多到缓冲上限）。"""
    with _lock:
        _buffer.extendleft(reversed(items))


async def flush_to_db(session) -> int:
    """把缓冲写进 `ai_call_log`。由定时任务每分钟调用。

    失败时把记录放回缓冲 —— 观测数据不该因为一次写失败就永久丢失。
    """
    from app.models import AICallLog

    items = drain()
    if not items:
        return 0

    try:
        for entry in items:
            session.add(
                AICallLog(
                    user_id=entry["user_id"],
                    task=entry["task"],
                    provider=entry["provider"],
                    model=entry["model"],
                    prompt_version=entry["prompt_version"],
                    prompt_tokens=entry["prompt_tokens"],
                    completion_tokens=entry["completion_tokens"],
                    cached_tokens=entry["cached_tokens"],
                    latency_ms=entry["latency_ms"],
                    ttft_ms=entry["ttft_ms"],
                    status=entry["status"],
                    error=entry["error"],
                    streamed=entry["streamed"],
                )
            )
        await session.flush()
    except Exception:
        restore(items)
        raise
    return len(items)


class timer:
    """计时的上下文管理器，顺手算出 TTFT。

    用法：
        with timer() as t:
            ...
            t.first_token()   # 流式：收到第一个块时调一次
        t.elapsed_ms, t.ttft_ms
    """

    __slots__ = ("_t0", "_ttft")

    def __init__(self) -> None:
        self._t0 = time.monotonic()
        self._ttft: float | None = None

    def __enter__(self) -> "timer":
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def first_token(self) -> None:
        if self._ttft is None:
            self._ttft = time.monotonic()

    @property
    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    @property
    def ttft_ms(self) -> int | None:
        if self._ttft is None:
            return None
        return int((self._ttft - self._t0) * 1000)
