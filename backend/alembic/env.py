"""Alembic 环境（异步引擎）。

- 从 app.core.config 注入 DATABASE_URL（覆盖 alembic.ini 的 sqlalchemy.url）。
- 离线模式（alembic upgrade head --sql）生成 PG DDL，无需真实连接。
- 在线模式（alembic upgrade head）走 asyncpg 连接真实库。
- compare_type=True：后续迁移能检测 NUMERIC 精度等类型变化。
"""
from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import get_settings
from app.db.base import Base

# 必须 import 所有模型，使其注册到 Base.metadata（供 autogenerate 比对）
import app.models  # noqa: F401

config = context.config
settings = get_settings()
# 默认仍指向开发库（ DATABASE_URL ）；测试库引导时由 conftest 注入
# ALEMBIC_DB_URL 覆盖（不影响开发迁移，dev.ps1 也从不变更此变量）。
config.set_main_option(
    "sqlalchemy.url", os.environ.get("ALEMBIC_DB_URL", settings.DATABASE_URL)
)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
