"""对镜 · 运行时指标

方案 7.7 要求监控四个指标：
    内存使用率 80% · CPU 持续 70% 超过 5 分钟 · 磁盘使用率 80% · SSE 连接数 100

其中三个从操作系统直接读得到（由 deploy/check-health.sh 负责），
只有 **SSE 连接数**必须在应用内埋点——它是长连接，外部看不到。

为什么这个数值得盯：Uvicorn 按方案 7.3 是单 worker，
每个 SSE 连接会占住一个协程并持有一次数据库会话。
连接数失控（比如前端泄漏没关）会先在内存上体现，等发现时已经晚了。
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_active_sse = 0
_total_sse = 0
_peak_sse = 0


def sse_opened() -> int:
    """SSE 连接建立。返回当前连接数。"""
    global _active_sse, _total_sse, _peak_sse
    with _lock:
        _active_sse += 1
        _total_sse += 1
        if _active_sse > _peak_sse:
            _peak_sse = _active_sse
        return _active_sse


def sse_closed() -> int:
    """SSE 连接关闭。返回当前连接数。

    必须放在 finally 里调用，否则客户端中途断开就会让计数只增不减，
    阈值告警从此永远为真。
    """
    global _active_sse
    with _lock:
        _active_sse = max(0, _active_sse - 1)
        return _active_sse


def snapshot() -> dict:
    with _lock:
        return {
            "sse_active": _active_sse,
            "sse_total": _total_sse,
            "sse_peak": _peak_sse,
        }
