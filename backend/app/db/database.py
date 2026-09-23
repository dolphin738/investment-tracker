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
    # 显式固定隔离级别（= PG 默认值，行为不变，此处只为**显式化依赖**）。
    # 理由：跨进程取消靠 ``admin_locks.cancel_requested_at`` 标记传递意图，而播种主循环在
    # 长事务中运行、只在每只证券结束时 commit——标记能否被持锁 worker 看见，取决于
    # 「READ COMMITTED 下每条语句取新快照」。若这里不显式声明、只靠 PG 的隐式默认，
    # 一旦有人把 server / 连接级默认改成 REPEATABLE READ，跨进程取消会在长事务内
    # **静默失效**（标记永远不可见，且无任何测试会报警）。
    isolation_level="READ COMMITTED",
)

AsyncSessionLocal = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：请求级会话，自动关闭。"""
    async with AsyncSessionLocal() as session:
        yield session
