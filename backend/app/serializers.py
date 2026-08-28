"""ORM 实体 → 响应 dict 序列化。

从 routers/common.py 迁出，使 service 层（如 aggregation）可复用序列化逻辑，
而不反向依赖 router 层（消除 service→router 分层违规）。

所有序列化函数均为纯函数：输入 ORM 实例，输出 camelCase 响应 dict。
金额字段由 EnvelopeJSONResponse 统一字符串化，此处保持 Decimal/date 原样。
"""
from __future__ import annotations

from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    Portfolio,
    PortfolioSecurity,
    Security,
    SecurityPrice,
    SecurityTrade,
    User,
)
from app.models.enums import DividendType


def serialize_portfolio(p: Portfolio) -> dict:
    return {
        "id": p.id,
        "userId": p.user_id,
        "name": p.name,
        "description": p.description,
        "baseDate": p.base_date,
        "currency": p.currency,
        "archivedAt": p.archived_at,
        "createdAt": p.created_at,
        "updatedAt": p.updated_at,
    }


def serialize_cashflow(c: CashFlow, rec=None) -> "CashflowOut":
    """组合出入金序列化：返回 CashflowOut 契约对象（REP-038 做法1）。

    将路由层手写的 recalculation 补丁收编进序列化器：调用方传入 rec
    （重算反馈源，含 from_date / affected_days / skipped_manual_days）即装填，
    否则 recalculation 为 None。出口仍由 response_model=CashflowOut 强制类型，
    wire JSON 与「序列化 dict + 路由补丁」逐字节一致。
    """
    from app.schemas_resp import CashflowOut, RecalculationMeta

    recalculation = None
    if rec is not None:
        recalculation = RecalculationMeta(
            fromDate=rec.from_date,
            affectedDays=rec.affected_days,
            skippedManualDays=rec.skipped_manual_days,
        )
    return CashflowOut(
        id=c.id,
        portfolioId=c.portfolio_id,
        date=c.date,
        type=c.type,
        amount=str(c.amount),
        note=c.note,
        createdAt=c.created_at,
        updatedAt=c.updated_at,
        recalculation=recalculation,
    )


def serialize_security(s: PortfolioSecurity) -> dict:
    """组合持仓（portfolio_securities）序列化：name/exchange 经 master_id JOIN 目录。"""
    from app.services.security import compute_type

    master = s.master
    code = master.code if master is not None else ""
    name = master.name if master is not None else ""
    exchange = master.exchange if master is not None else None
    stype = compute_type(s)
    return {
        "id": s.id,
        "code": code,
        "name": name,
        "type": stype.value,
        "exchange": exchange,
        "currency": s.currency,
        "masterId": s.master_id,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
    }


def serialize_security_master(s: Security) -> dict:
    """系统级证券主数据行（目录表）序列化：左栏只读展示用。"""
    return {
        "id": s.id,
        "code": s.code,
        "name": s.name,
        "exchange": s.exchange,
        "assetClass": s.asset_class.value if s.asset_class is not None else None,
        "updatedAt": s.updated_at,
    }


def serialize_trade(t: SecurityTrade) -> dict:
    return {
        "id": t.id,
        "securityId": t.security_id,
        "date": t.date,
        "side": t.side.value,
        "quantity": t.quantity,
        "costPrice": t.cost_price,
        "commission": t.commission,
        "stampTax": t.stamp_tax,
        "other": t.other,
        "feeTotal": t.fee_total,
        "note": t.note,
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
    }


def serialize_price(p: SecurityPrice) -> dict:
    return {
        "id": p.id,
        "securityId": p.security_id,
        "price": p.price,
        "asOf": p.as_of,
        "createdAt": p.created_at,
        # SecurityPrice 为不可变记录（仅 CreatedAtMixin，无 updated_at 列），
        # updatedAt 语义等同 createdAt，避免为仅此处新增迁移列。
        "updatedAt": p.created_at,
    }


def serialize_cashbalance(c: CashBalance) -> dict:
    return {
        "id": c.id,
        "amount": c.amount,
        "asOf": c.as_of,
        "note": c.note,
        "createdAt": c.created_at,
        # CashBalance 为不可变记录（仅 CreatedAtMixin），updatedAt 等同 createdAt。
        "updatedAt": c.created_at,
    }


def serialize_snapshot(s: AssetSnapshot, derived_total=None) -> dict:
    return {
        "id": s.id,
        "portfolioId": s.portfolio_id,
        "date": s.date,
        "totalAsset": s.total_asset,
        "marketValue": s.market_value,
        "cashBalance": s.cash_balance,
        "source": s.source.value,
        "valuationFlag": s.valuation_flag.value,
        "note": s.note,
        "recordedAt": s.recorded_at,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
        "derivedTotalAsset": derived_total,
    }


def serialize_dividend(d, sec=None) -> dict:
    sec_code = (
        sec.master.code
        if sec is not None and sec.master is not None
        else None
    )
    sec_name = (
        sec.master.name
        if sec is not None and sec.master is not None
        else None
    )
    net = d.amount - d.tax
    return {
        "id": d.id,
        "securityId": d.security_id,
        "securityCode": sec_code,
        "securityName": sec_name,
        "date": d.date,
        "amount": d.amount,
        "tax": d.tax,
        "netAmount": net,
        "type": d.type.value if isinstance(d.type, DividendType) else d.type,
        "note": d.note,
        "createdAt": d.created_at,
        # DividendRecord 为不可变记录（仅 CreatedAtMixin），updatedAt 等同 createdAt。
        "updatedAt": d.created_at,
    }


def serialize_preference(p) -> dict:
    return {
        "id": p.id,
        "defaultPortfolioId": p.default_portfolio_id,
        "defaultGranularity": p.default_granularity,
        "defaultDateRange": p.default_date_range,
        "aggregation": p.aggregation,
        "weekStartsOn": p.week_starts_on,
        "navDecimals": p.nav_decimals,
        "xirrDecimals": p.xirr_decimals,
        "theme": p.theme,
        "staleDays": p.stale_days,
        "showLiquidated": p.show_liquidated,
        "costBasisView": p.cost_basis_view,
        "cashHintOnCashflow": p.cash_hint_on_cashflow,
        "cashHintOnTrade": p.cash_hint_on_trade,
        "amountThousands": p.amount_thousands,
        "amountAbbrev": p.amount_abbrev,
        "dashboardLayout": p.dashboard_layout,
    }


def serialize_user(user: User) -> dict:
    """当前用户响应 dict（对齐 serializers.py 风格：纯函数，输入 User ORM 实例）。

    与 auth/router.py 各路由曾逐份内联的 user dict 键集、表达式逐字一致；
    收敛到此单一来源，消除重复构造。
    """
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatar": user.avatar,
        "phone": user.phone,
        "bio": user.bio,
        "role": user.role,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
    }
