"""证券买卖资源 Service — 对齐 app/ SecurityTradeService。

从 routers/data.py 的 security-trades 路由内联逻辑抽出；含 §9.2 卖出硬校验
（_assert_sell_ok，移入本 Service）。继承 PortfolioChildService 复用 get_scoped。

注意：本 Service 仅返回 ORM 对象，序列化仍由 router 负责。删除走「净删除 +
重算 + 孤儿清理」，与原路由保持一致（无 recalc 反馈）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.finance_core.holding import ZERO
from app.models import SecurityTrade
from app.models.enums import SecuritySide
from app.schemas import TradeCreateReq, TradePatchReq
from app.services.base import PortfolioChildService, coerce_enum, split_ids, validate_date_not_future
from app.services.holding import HoldingService
from app.services.recalculation import RecalculationService


def _check_no_oversell(trades: list) -> str | None:
    """回放全部证券买卖，校验任意时点持仓不为负（导入批量 SELL 硬校验，对齐 §9.2）。

    与手动 create_trade 的 _assert_sell_ok 口径一致：quantity 恒正、side 区分买卖。
    同日期 BUY 先于 SELL，允许当日买入即卖出。返回错误字符串；无超额返回 None。
    """
    by_sec: dict[str, list] = {}
    for t in trades:
        by_sec.setdefault(t.security_id, []).append(t)
    for sec_id, items in by_sec.items():
        ordered = sorted(
            items,
            key=lambda t: (t.date, 0 if t.side is SecuritySide.BUY_SEC else 1),
        )
        held = Decimal(0)
        for t in ordered:
            delta = t.quantity if t.side is SecuritySide.BUY_SEC else -t.quantity
            held += delta
            if held < 0:
                return (
                    f"证券 {sec_id} 在 {t.date.isoformat()} 卖出超额："
                    f"累计持仓将变为 {held}，不能为负"
                )
    return None


class TradeService(PortfolioChildService):
    async def list_stmt(
        self,
        portfolio_id: str,
        security_id: Optional[str] = None,
        side: Optional[str] = None,
        start: Optional[date] = None,
        end: Optional[date] = None,
    ):
        """构造带过滤/排序的查询（分页交给 router 的 paginate）。"""
        stmt = select(SecurityTrade).where(SecurityTrade.portfolio_id == portfolio_id)
        if security_id:
            ids = split_ids(security_id)
            if ids:
                stmt = stmt.where(SecurityTrade.security_id.in_(ids))
        if side:
            stmt = stmt.where(
                SecurityTrade.side == coerce_enum(SecuritySide, side, "side")
            )
        if start:
            stmt = stmt.where(SecurityTrade.date >= start)
        if end:
            stmt = stmt.where(SecurityTrade.date <= end)
        stmt = stmt.order_by(
            SecurityTrade.date.desc(), SecurityTrade.created_at.desc()
        )
        return stmt

    async def get(self, portfolio_id: str, trade_id: str) -> SecurityTrade:
        """按 id 取买卖流水并校验归属（404 不泄露存在性）。"""
        return await self.get_scoped(SecurityTrade, trade_id, portfolio_id)

    async def _assert_sell_ok(
        self,
        portfolio_id: str,
        security_id: str,
        as_of: date,
        quantity: Decimal,
        exclude_trade_id: Optional[str] = None,
    ) -> None:
        """§9.2 卖出硬校验：卖出量不得超过当前及后续日期持仓。"""
        held = await HoldingService(self.session).derive(
            portfolio_id,
            as_of,
            include_closed=True,
            security_id=security_id,
            exclude_trade_id=exclude_trade_id,
        )
        view = next((h for h in held if h.security_id == security_id), None)
        current = view.quantity if view is not None else ZERO
        if quantity > current:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message=f"当前持有 {current}，最多可卖 {current}",
                status_code=400,
            )

        # 后续日期负持仓检查：插入历史卖出可能导致后续已有卖出日期持仓为负
        future_sell_dates: list[date] = (
            await self.session.execute(
                select(SecurityTrade.date)
                .where(
                    SecurityTrade.portfolio_id == portfolio_id,
                    SecurityTrade.security_id == security_id,
                    SecurityTrade.side == SecuritySide.SELL_SEC,
                    SecurityTrade.date > as_of,
                )
                .distinct()
            )
        ).scalars().all()
        for d in future_sell_dates:
            held = await HoldingService(self.session).derive(
                portfolio_id,
                d,
                include_closed=True,
                security_id=security_id,
                exclude_trade_id=exclude_trade_id,
            )
            view = next((h for h in held if h.security_id == security_id), None)
            held_qty = view.quantity if view is not None else ZERO
            if quantity > held_qty:
                raise BusinessException(
                    code=BusinessErrorCode.VALIDATION_FAILED,
                    message=f"日期 {d.isoformat()} 持仓 {held_qty}，加入本次卖出后将不足",
                    status_code=400,
                )

    async def create(
        self, portfolio_id: str, req: TradeCreateReq
    ) -> SecurityTrade:
        side = coerce_enum(SecuritySide, req.side, "side")
        # D1：日期不能为未来（对齐 app/ validateDateNotFuture）
        validate_date_not_future(req.date)
        if side is SecuritySide.SELL_SEC:
            await self._assert_sell_ok(
                portfolio_id, req.securityId, req.date, req.quantity
            )
        trade = SecurityTrade(
            portfolio_id=portfolio_id,
            security_id=req.securityId,
            date=req.date,
            side=side,
            quantity=req.quantity,
            cost_price=req.cost_price,
            fee_total=req.fee_total or Decimal(0),
            commission=req.commission or Decimal(0),
            stamp_tax=req.stamp_tax or Decimal(0),
            other=req.other or Decimal(0),
        )
        self.session.add(trade)
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, req.date
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, req.date, force_dates=force
        )
        return trade

    async def bulk_create(self, portfolio_id: str, rows: list[dict]) -> int:
        """导入批量写入：构造 + 卖出硬校验（对齐 §9.2）+ add，不 commit
        （commit 由 data_transfer.commit_import 在末尾统一做）。返回写入条数。

        与 REST 单条 create 收敛到同一 Service，消除导入路径的双真源。
        """
        existing = (
            await self.session.execute(
                select(SecurityTrade).where(SecurityTrade.portfolio_id == portfolio_id)
            )
        ).scalars().all()
        batch = [
            SecurityTrade(
                portfolio_id=portfolio_id,
                security_id=r["security_id"],
                date=date.fromisoformat(r["date"]),
                side=SecuritySide(r["side"]),
                quantity=Decimal(r["quantity"]),
                cost_price=Decimal(r["costPrice"]),
                fee_total=Decimal(r.get("feeTotal") or "0"),
                note=r.get("note") or None,
            )
            for r in rows
        ]
        oversell = _check_no_oversell(list(existing) + batch)
        if oversell:
            raise BusinessException(
                BusinessErrorCode.VALIDATION_FAILED, oversell, status_code=400
            )
        for t in batch:
            self.session.add(t)
        return len(batch)

    async def patch(
        self, portfolio_id: str, trade_id: str, req: TradePatchReq
    ) -> SecurityTrade:
        trade = await self.get_scoped(SecurityTrade, trade_id, portfolio_id)
        old_date = trade.date
        new_date = req.date if req.date is not None else trade.date
        new_side = (
            coerce_enum(SecuritySide, req.side, "side")
            if req.side is not None
            else trade.side
        )
        new_qty = req.quantity if req.quantity is not None else trade.quantity
        if req.date is not None:
            validate_date_not_future(new_date)
        if new_side is SecuritySide.SELL_SEC:
            await self._assert_sell_ok(
                portfolio_id,
                trade.security_id,
                new_date,
                new_qty,
                exclude_trade_id=trade.id,
            )
        if req.date is not None:
            trade.date = req.date
        if req.quantity is not None:
            trade.quantity = req.quantity
        if req.cost_price is not None:
            trade.cost_price = req.cost_price
        if req.fee_total is not None:
            trade.fee_total = req.fee_total
        if req.commission is not None:
            trade.commission = req.commission
        if req.stamp_tax is not None:
            trade.stamp_tax = req.stamp_tax
        if req.other is not None:
            trade.other = req.other
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, min(new_date, old_date)
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, min(new_date, old_date), force_dates=force
        )
        return trade

    async def delete(self, portfolio_id: str, trade_id: str) -> None:
        """净删除买卖 + 重算 + 孤儿清理（与原路由一致：无 recalc 反馈）。"""
        trade = await self.get_scoped(SecurityTrade, trade_id, portfolio_id)
        d = trade.date
        await self.session.delete(trade)
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, d
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, d, force_dates=force
        )
        # 问题2：删除买卖后清理残留 0 值孤儿 DERIVED 快照
        from app.services.asset_valuation import AssetValuationService

        await AssetValuationService(self.session).prune_zero_orphans(portfolio_id, d)
        # prune 已不再内部重算：清理 0 值孤儿后需再重算一次 nav 链
        await RecalculationService(self.session).recalculateNavRange(portfolio_id, d)
