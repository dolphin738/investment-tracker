"""Phase 3 集成测试公共夹具。

核心约束：真实 Postgres + asyncpg。测试连接指向独立的测试库（TEST_DATABASE_URL），
与开发库（DATABASE_URL，dev.ps1 / uvicorn 使用）物理隔离，避免测试 TRUNCATE 污染
开发数据。

- _test_db_bootstrap（session）：首次运行确保测试库存在并按 Alembic 迁移建表（与
  开发库同源，保证 ON DELETE CASCADE 等约束一致），仅执行一次。
- _engine（function）：用 TEST_DATABASE_URL 建引擎 + patch app.db.database 全局，结束时 dispose。
- _clean_db（autouse）：每个测试前 TRUNCATE 全表。
- client（function）：httpx.AsyncClient + ASGITransport 访问真实 app。
"""
from __future__ import annotations

import os
import subprocess
import sys
from sqlalchemy import text
from sqlalchemy.pool import NullPool

import pytest_asyncio

import app.db.database as dbmod
from app.db.base import Base
import app.models  # noqa: F401  确保全部模型注册到 Base.metadata

import pytest


def _db_name_from_url(url: str) -> str:
    # postgresql+asyncpg://user:pass@host:port/dbname
    return url.rstrip("/").split("/")[-1]


@pytest_asyncio.fixture(scope="session")
async def _test_db_bootstrap():
    """确保测试库存在且 schema 与开发库一致（按 Alembic 迁移，每个会话仅一次）。"""
    settings = dbmod.settings
    test_url = settings.TEST_DATABASE_URL
    test_db = _db_name_from_url(test_url)
    backend_dir = os.path.dirname(os.path.abspath(__file__))

    # 1) 在任一已有库（这里复用开发库连接，仅做管理操作，绝不触碰其数据）上
    #    重建测试库：存在则 DROP 再 CREATE，保证每次测试会话都从 Alembic 迁移
    #    全新建库（与开发库同源，级联等约束一致；且免除手工重置陈旧 schema）。
    #    需要连接用户具备 CREATEDB / 属主权限；DROP 时测试库应无活动连接。
    admin_engine = dbmod.create_async_engine(
        settings.DATABASE_URL, echo=False, future=True, poolclass=NullPool
    )
    try:
        async with admin_engine.connect() as conn:
            # DROP / CREATE DATABASE 不能在事务块内执行，须 autocommit
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            # 先终止测试库上的其它连接（防御：CI / IDE / 上次未释放的残留连接），
            # 否则 DROP 会因 “being accessed by other users” 失败。仅终止同角色自有连接。
            await conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :n AND pid <> pg_backend_pid()"
                ),
                {"n": test_db},
            )
            exists = await conn.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": test_db},
            )
            if exists:
                await conn.execute(text(f'DROP DATABASE "{test_db}"'))
            await conn.execute(text(f'CREATE DATABASE "{test_db}"'))
    finally:
        await admin_engine.dispose()

    # 2) 按 Alembic 迁移在测试库建表（与开发库同源，保证级联等约束一致；幂等）。
    #    env.py 在设置了 ALEMBIC_DB_URL 时把迁移目标切到测试库；开发迁移不受影响。
    #    若后续迁移演化、测试库 schema 落后，删除该库即可强制重建：
    #      DROP DATABASE investment_return_tracker_test;
    env = {**os.environ, "ALEMBIC_DB_URL": test_url}
    env["PYTHONPATH"] = backend_dir + os.pathsep + env.get("PYTHONPATH", "")
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir,
        env=env,
        check=True,
    )

    yield


@pytest_asyncio.fixture
async def _engine(_test_db_bootstrap):
    # NullPool：每次 checkout 新建连接并绑定当前（function）循环，规避 asyncpg
    # 连接复用导致的 “attached to a different loop” / MissingGreenlet（ASGI 请求内
    # 的 greenlet 与夹具/连接池绑定循环不一致）。测试场景连接数低，代价可忽略。
    # 指向测试专用库，与开发库隔离。
    eng = dbmod.create_async_engine(
        dbmod.settings.TEST_DATABASE_URL, echo=False, future=True, poolclass=NullPool
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


@pytest_asyncio.fixture
async def session(_engine):
    """测试用 DB 会话（指向测试库，function 作用域，随 _engine 共用循环）。"""
    async with dbmod.AsyncSessionLocal() as s:
        yield s
