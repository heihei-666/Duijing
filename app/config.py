"""对镜 · 全局配置

所有可变项都通过环境变量注入，代码里不写死任何密钥。
部署时复制 .env.example 为 .env 并填写。
"""

import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default


def _list(name: str, default: list[str] | None = None) -> list[str]:
    raw = os.getenv(name, "")
    if not raw.strip():
        return list(default or [])
    return [item.strip() for item in raw.split(",") if item.strip()]


def _resolve_jwt_secret() -> str:
    """JWT 密钥。

    优先取环境变量；没有则在 data/ 下落一个持久化文件。
    这样做是为了避免开发环境每次重启都让已登录用户掉线，
    同时保证密钥不会出现在代码或仓库里（data/ 已在 .gitignore）。
    """
    env_secret = os.getenv("JWT_SECRET", "").strip()
    if env_secret:
        return env_secret

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    secret_file = DATA_DIR / ".jwt_secret"
    if secret_file.exists():
        cached = secret_file.read_text(encoding="utf-8").strip()
        if cached:
            return cached

    generated = secrets.token_urlsafe(48)
    secret_file.write_text(generated, encoding="utf-8")
    try:
        secret_file.chmod(0o600)
    except OSError:
        pass
    return generated


class Settings:
    # ── 应用 ──────────────────────────────────────────────
    APP_NAME: str = os.getenv("APP_NAME", "对镜")
    ENV: str = os.getenv("ENV", "dev")
    DEBUG: bool = _bool("DEBUG", False)
    TZ: str = os.getenv("TZ", "Asia/Shanghai")

    # ── 数据库 ────────────────────────────────────────────
    DB_PATH: str = os.getenv("DB_PATH", str(DATA_DIR / "duijing.db"))

    # ── 认证 ──────────────────────────────────────────────
    JWT_SECRET: str = _resolve_jwt_secret()
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_DAYS: int = _int("JWT_EXPIRE_DAYS", 7)
    COOKIE_NAME: str = "dj_token"
    # 生产环境走 HTTPS，必须置 true
    COOKIE_SECURE: bool = _bool("COOKIE_SECURE", False)
    COOKIE_DOMAIN: str | None = os.getenv("COOKIE_DOMAIN") or None

    # ── 注册 ──────────────────────────────────────────────
    # 为空表示不启用固定邀请码，仅用库内邀请码
    BOOTSTRAP_INVITE_CODE: str = os.getenv("BOOTSTRAP_INVITE_CODE", "").strip().upper()
    # 是否允许无邀请码自由注册（默认关闭）
    ALLOW_OPEN_REGISTER: bool = _bool("ALLOW_OPEN_REGISTER", False)

    # ── CORS ──────────────────────────────────────────────
    CORS_ORIGINS: list[str] = _list(
        "CORS_ORIGINS", ["http://localhost:5173", "http://127.0.0.1:5173"]
    )

    # ── AI ────────────────────────────────────────────────
    # mock | deepseek | mimo | hybrid
    AI_PROVIDER: str = os.getenv("AI_PROVIDER", "mock").strip().lower()

    DEEPSEEK_API_KEY: str = os.getenv("DEEPSEEK_API_KEY", "").strip()
    DEEPSEEK_BASE_URL: str = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    DEEPSEEK_MODEL: str = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")

    MIMO_API_KEY: str = os.getenv("MIMO_API_KEY", "").strip()
    MIMO_BASE_URL: str = os.getenv("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1").rstrip("/")
    MIMO_MODEL: str = os.getenv("MIMO_MODEL", "mimo-v2.6-flash")

    # 思考模式下的辩论回复实测 3-5 秒，但网络抖动或长复盘可能超过 1 分钟。
    # 实测在弱网容器里出现过一次 >120s 的读取超时，这里放宽到 180。
    AI_TIMEOUT_SECONDS: int = _int("AI_TIMEOUT_SECONDS", 180)
    AI_MAX_RETRIES: int = _int("AI_MAX_RETRIES", 2)

    # ── 限流 ──────────────────────────────────────────────
    DEBATE_RATE_PER_MIN: int = _int("DEBATE_RATE_PER_MIN", 10)
    AI_RATE_PER_MIN: int = _int("AI_RATE_PER_MIN", 6)
    LOGIN_RATE_PER_MIN: int = _int("LOGIN_RATE_PER_MIN", 10)
    LOGIN_LOCK_THRESHOLD: int = _int("LOGIN_LOCK_THRESHOLD", 5)
    LOGIN_LOCK_MINUTES: int = _int("LOGIN_LOCK_MINUTES", 15)

    # ── 归档规则 ──────────────────────────────────────────
    WEAKNESS_DELETE_DAYS: int = _int("WEAKNESS_DELETE_DAYS", 60)
    ADVANTAGE_ARCHIVE_DAYS: int = _int("ADVANTAGE_ARCHIVE_DAYS", 30)
    OBSERVATION_TTL_HOURS: int = _int("OBSERVATION_TTL_HOURS", 24)

    # ── 辩论规则 ──────────────────────────────────────────
    DEBATE_MIN_ROUNDS: int = _int("DEBATE_MIN_ROUNDS", 4)
    DEBATE_MAX_ROUNDS: int = _int("DEBATE_MAX_ROUNDS", 8)
    DEBATE_MESSAGE_MAX_CHARS: int = _int("DEBATE_MESSAGE_MAX_CHARS", 300)
    DEBATE_MAX_PARTICIPANTS: int = _int("DEBATE_MAX_PARTICIPANTS", 4)

    # ── 定时任务 ──────────────────────────────────────────
    ENABLE_SCHEDULER: bool = _bool("ENABLE_SCHEDULER", True)
    # 事件卡批量扫描：每周日 02:00
    SCAN_CRON_DAY: str = os.getenv("SCAN_CRON_DAY", "sun")
    SCAN_CRON_HOUR: int = _int("SCAN_CRON_HOUR", 2)


settings = Settings()
