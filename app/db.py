"""对镜 · 数据库连接层

SQLite + WAL。PRAGMA 按方案文档 4.4 配置：
    journal_mode = WAL
    synchronous  = NORMAL
    cache_size   = -8000   (约 8MB)
    busy_timeout = 5000
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


def _ensure_db_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


_ensure_db_dir(settings.DB_PATH)

DATABASE_URL = f"sqlite+aiosqlite:///{settings.DB_PATH}"

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    # SQLite 单文件写入，连接池保守一些更稳
    pool_pre_ping=True,
)

SessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
    """每条新连接都套上文档要求的 PRAGMA。"""
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-8000")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖注入用的会话工厂。"""
    async with SessionLocal() as session:
        yield session


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """脚本与后台任务用的上下文管理器，自动提交/回滚。"""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """建表。首次启动自动执行，幂等。"""
    from app import models  # noqa: F401  确保模型已注册到 metadata

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # 轻量迁移：给已存在的库补列（SQLite 不支持 IF NOT EXISTS ADD COLUMN）
        await conn.run_sync(_apply_light_migrations)


def _apply_light_migrations(conn) -> None:
    """对已存在的表做增量补列。

    方案仍在演进期，这里只做「加列」这类安全操作；
    真正的破坏性变更走 migrations/ 下的脚本。
    """
    from sqlalchemy import inspect

    inspector = inspect(conn)
    existing_tables = set(inspector.get_table_names())

    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue
        present = {col["name"] for col in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in present:
                continue
            ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column.type.compile(conn.dialect)}'
            if column.default is not None and column.default.is_scalar:
                default_value = column.default.arg
                if isinstance(default_value, bool):
                    ddl += f" DEFAULT {1 if default_value else 0}"
                elif isinstance(default_value, (int, float)):
                    ddl += f" DEFAULT {default_value}"
                elif isinstance(default_value, str):
                    escaped = default_value.replace("'", "''")
                    ddl += f" DEFAULT '{escaped}'"
            conn.execute(text(ddl))


async def healthcheck() -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
