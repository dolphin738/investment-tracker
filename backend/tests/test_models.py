"""Phase 1 模型验证：元数据注册 + 真实库 round-trip（异步 ORM 插入/查询/级联删除）。

要求：backend/.env 指向可用的 PostgreSQL（dev.ps1 初始化时已复制示例）。
测试对真实库做自清理（末尾级联删除测试用户），不污染数据。
"""
from __future__ import annotations

import datetime
from decimal import Decimal

import pytest
from sqlalchemy import select, text

from app.db.base import Base
import app.db.database as dbmod  # 用 dbmod.AsyncSessionLocal() 取“调用时”的会话工厂，
# 以承接 conftest 对测试库的 patch（模块级 `from ... import AsyncSessionLocal` 会
# 在导入时捕获开发库工厂，绕过测试库隔离）。
import app.models  # noqa: F401  ensure all models registered
from app.models import (
    DailyNav,
    DailyXirr,
    Portfolio,
    Security,
    SecuritySide,
    SecurityTrade,
    SecurityType,
    User,
)


def test_metadata_tables_and_enums():
    """12 表 + 6 原生枚举已注册，精度与 Prisma 一致。"""
    tables = set(Base.metadata.tables.keys())
    assert {
        "users",
        "portfolios",
        "cashflows",
        "securities",
        "security_trades",
        "security_prices",
        "cash_balances",
        "asset_snapshots",
        "daily_nav",
        "daily_xirr",
        "dividend_records",
        "user_preferences",
        # 增量：系统配置（admin 系统配置功能，含证券行情 API 地址）
        "system_configs",
    } == tables

    enums = {
        c.type.name
        for t in Base.metadata.tables.values()
        for c in t.columns
        if getattr(c.type, "native_enum", False) and c.type.name
    }
    assert {
        "CashFlowType",
        "SecurityType",
        "SecuritySide",
        "SnapshotSource",
        "SnapshotValuation",
        "DividendType",
    } == enums

    # 精度对齐 PRD 8.1
    assert Base.metadata.tables["security_trades"].c["quantity"].type.scale == 6
    assert Base.metadata.tables["daily_xirr"].c["xirr_value"].type.precision == 20
    assert Base.metadata.tables["daily_xirr"].c["xirr_value"].type.scale == 8
    assert Base.metadata.tables["daily_nav"].c["unit_nav"].type.scale == 6


@pytest.mark.asyncio
async def test_orm_roundtrip_and_cascade():
    """异步插入 User→Portfolio→Security→SecurityTrade，查询回环 + ORM 级联删除。"""
    marker = "phase1_test@example.com"
    async with dbmod.AsyncSessionLocal() as s:
        # 清理历史遗留
        await s.execute(text("DELETE FROM users WHERE email = :e"), {"e": marker})
        await s.commit()

        u = User(email=marker, password_hash="x", name="t")
        s.add(u)
        await s.flush()
        assert u.id and len(u.id) == 36  # gen_random_uuid 由 DB 生成

        p = Portfolio(user_id=u.id, name="P1")
        s.add(p)
        await s.flush()
        sec = Security(portfolio_id=p.id, code="T1", name="T", type=SecurityType.STOCK)
        s.add(sec)
        await s.flush()
        tr = SecurityTrade(
            portfolio_id=p.id,
            security_id=sec.id,
            date=datetime.date(2026, 3, 4),
            side=SecuritySide.BUY_SEC,
            quantity=Decimal("12.5"),
            cost_price=Decimal("9.75"),
            fee_total=Decimal("2"),
        )
        s.add(tr)
        await s.commit()

        tr2 = (
            await s.execute(select(SecurityTrade).where(SecurityTrade.id == tr.id))
        ).scalar_one()
        assert tr2.quantity == Decimal("12.5")
        assert tr2.side is SecuritySide.BUY_SEC
        assert tr2.portfolio.user.email == marker

        # ORM 级联删除（依赖 relationship passive_deletes=True + DB CASCADE）
        await s.delete(u)
        await s.commit()

        n_u = (await s.execute(select(User).where(User.email == marker))).scalars().all()
        n_t = (await s.execute(select(SecurityTrade))).scalars().all()
        n_p = (await s.execute(select(Portfolio))).scalars().all()
        assert len(n_u) == 0 and len(n_t) == 0 and len(n_p) == 0
