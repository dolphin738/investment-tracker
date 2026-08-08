"""Phase 3 集成测试公共夹具。

核心约束：真实 Postgres + asyncpg。pytest-asyncio 在 asyncio_default_test_loop_scope=function
下，async 测试与 async 夹具共用同一个 function 循环（已用调试用例确认：不再出现
「夹具 session 循环 / 测试 function 循环」错位）。故引擎按「每个测试」重建并绑定当前
function 循环，teardown 同循环 dispose，彻底规避 asyncpg “different loop” 报错。

- _engine（function）：建引擎 + patch app.db.database 全局，结束时 dispose。
- _clean_db（autouse）：每个测试前 TRUNCATE 全表。
- client（function）：httpx.AsyncClient + ASGITransport 访问真实 app。
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.pool import NullPool

import pytest_asyncio

import app.db.database as dbmod
from app.db.base import Base
import app.models  # noqa: F401  确保全部模型注册到 Base.metadata

import pytest


@pytest_asyncio.fixture
async def _engine():
    # NullPool：每次 checkout 新建连接并绑定当前（function）循环，规避 asyncpg
    # 连接复用导致的 “attached to a different loop” / MissingGreenlet（ASGI 请求内
    # 的 greenlet 与夹具/连接池绑定循环不一致）。测试场景连接数低，代价可忽略。
    eng = dbmod.create_async_engine(
        dbmod.settings.DATABASE_URL, echo=False, future=True, poolclass=NullPool
    )
    # patch app 全局：所有路由的 get_db / 服务均经此 function-loop 引擎
    old_engine = dbmod.engine
    old_sm = dbmod.AsyncSessionLocal
    dbmod.engine = eng
    dbmod.AsyncSessionLocal = dbmod.async_sessionmaker(
        eng, class_=dbmod.AsyncSession, expire_on_commit=False
    )
    yield eng
    await eng.dispose()
    dbmod.engine = old_engine
    dbmod.AsyncSessionLocal = old_sm


@pytest_asyncio.fixture(autouse=True)
async def _clean_db(_engine):
    async with dbmod.AsyncSessionLocal() as session:
        names = ", ".join(t.name for t in Base.metadata.sorted_tables)
        await session.execute(
            text(f"TRUNCATE TABLE {names} RESTART IDENTITY CASCADE")
        )
        await session.commit()


@pytest_asyncio.fixture
async def client(_engine):
    from httpx import AsyncClient, ASGITransport

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
