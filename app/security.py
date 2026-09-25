"""对镜 · 密码与令牌

密码用 bcrypt 直接处理（不引 passlib：passlib 1.7.4 与 bcrypt 4.x 组合
会打印 `(trapped) error reading bcrypt version` 噪声，直接调更干净）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings

# bcrypt 只处理前 72 字节，超出部分会被静默丢弃，这里显式截断避免歧义
_BCRYPT_MAX_BYTES = 72


def _encode(password: str) -> bytes:
    return password.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_encode(password), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(_encode(password), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int, username: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "iat": int(now.timestamp()),
        "exp": now + timedelta(days=settings.JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """解码失败一律返回 None，由调用方转成 401。"""
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def validate_password_strength(password: str) -> str | None:
    """返回错误信息；通过则返回 None。"""
    if not password or len(password) < 8:
        return "密码至少 8 位"
    if len(password) > 128:
        return "密码过长"
    if password.isdigit():
        return "密码不能是纯数字"
    return None


def validate_username(username: str) -> str | None:
    if not username:
        return "用户名不能为空"
    if len(username) < 3 or len(username) > 32:
        return "用户名长度需在 3–32 位之间"
    if not all(ch.isalnum() or ch in "_-" for ch in username):
        return "用户名只能包含字母、数字、下划线和短横线"
    return None
