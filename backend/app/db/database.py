"""异步数据库引擎 / Session（SQLAlchemy 2.0 async + asyncpg）。

Phase 1：提供 engine、AsyncSessionLocal、get_db 依赖。配置来自 app.core.config。
"""
from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

settings = get_settings()

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    future=True,
)

AsyncSessionLocal = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：请求级会话，自动关闭。"""
    async with AsyncSessionLocal() as session:
        yield session
