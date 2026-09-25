"""对镜 · 限流

方案 7.9 要求：
  · 辩论房每用户每分钟最多 10 次发言
  · 登录每 IP 每分钟 10 次，连续失败 5 次锁 15 分钟

按方案 7.3 部署为单 worker，进程内滑动窗口足够；
若将来扩到多 worker，这里换成 Redis 即可（接口不变）。
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, status


class SlidingWindowLimiter:
    def __init__(self, window_seconds: int = 60) -> None:
        self._window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        bucket = self._hits[key]
        cutoff = now - self._window
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        return bucket

    def allow(self, key: str, limit: int) -> bool:
        now = time.monotonic()
        with self._lock:
            bucket = self._prune(key, now)
            if len(bucket) >= limit:
                return False
            bucket.append(now)
            return True

    def retry_after(self, key: str, limit: int) -> int:
        now = time.monotonic()
        with self._lock:
            bucket = self._prune(key, now)
            if len(bucket) < limit:
                return 0
            return max(1, int(self._window - (now - bucket[0])) + 1)

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


class FailureLockout:
    """连续失败 N 次锁定 M 分钟。"""

    def __init__(self, threshold: int, lock_minutes: int) -> None:
        self._threshold = threshold
        self._lock_seconds = lock_minutes * 60
        self._failures: dict[str, list] = {}
        self._lock = threading.Lock()

    def is_locked(self, key: str) -> int:
        """返回剩余锁定秒数，0 表示未锁定。"""
        now = time.monotonic()
        with self._lock:
            entry = self._failures.get(key)
            if not entry:
                return 0
            count, locked_at = entry
            if count < self._threshold or locked_at is None:
                return 0
            remaining = int(self._lock_seconds - (now - locked_at))
            if remaining <= 0:
                self._failures.pop(key, None)
                return 0
            return remaining

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            count, locked_at = self._failures.get(key, (0, None))
            count += 1
            if count >= self._threshold:
                locked_at = now
            self._failures[key] = [count, locked_at]

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


# 全局实例
debate_limiter = SlidingWindowLimiter(60)
ai_limiter = SlidingWindowLimiter(60)
login_limiter = SlidingWindowLimiter(60)


def login_lockout(threshold: int, lock_minutes: int) -> FailureLockout:
    return FailureLockout(threshold, lock_minutes)


def enforce(limiter: SlidingWindowLimiter, key: str, limit: int, message: str) -> None:
    if limiter.allow(key, limit):
        return
    retry_after = limiter.retry_after(key, limit)
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"{message}，请 {retry_after} 秒后重试",
        headers={"Retry-After": str(retry_after)},
    )


def client_ip(request) -> str:
    """取真实客户端 IP。Nginx 反代下读 X-Forwarded-For 第一段。"""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"
