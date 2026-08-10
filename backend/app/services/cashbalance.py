"""现金余额资源 Service — 对齐 app/ CashBalanceService。

从 routers/data.py 的 cash-balances 路由内联逻辑抽出；含同 as_of 的 upsert
（覆盖更新）。继承 PortfolioChildService 复用 get_scoped。

注意：本 Service 仅返回 ORM 对象，序列化仍由 router 负责。删除走「净删除 +
重算 + 孤儿清理」，与原路由一致（无 recalc 反馈）。现金余额独立于出入金，
不自动改余额（方案 B 口径）。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CashBalance
from app.schemas import CashBalanceCreateReq, CashBalancePatchReq
from app.services.asset_valuation import AssetValuationService
from app.services.base import PortfolioChildService
from app.services.recalculation import RecalculationService


class CashBalanceService(PortfolioChildService):
    async def list_stmt(
        self, portfolio_id: str, as_of: Optional[date] = None
    ):
        """构造带过滤/排序的查询（分页交给 router 的 paginate）。"""
        stmt = select(CashBalance).where(CashBalance.portfolio_id == portfolio_id)
        if as_of:
            stmt = stmt.where(CashBalance.as_of == as_of)
        stmt = stmt.order_by(
            CashBalance.as_of.desc(), CashBalance.created_at.desc()
        )
        return stmt

    async def get(self, portfolio_id: str, cb_id: str) -> CashBalance:
        """按 id 取现金余额并校验归属（404 不泄露存在性）。"""
        return await self.get_scoped(CashBalance, cb_id, portfolio_id)

    async def create(
        self, portfolio_id: str, req: CashBalanceCreateReq
    ) -> CashBalance:
        existing = (
            await self.session.execute(
                select(CashBalance).where(
                    CashBalance.portfolio_id == portfolio_id,
                    CashBalance.as_of == req.asOf,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.amount = req.amount
            existing.note = req.note
            cb = existing
        else:
            cb = CashBalance(
                portfolio_id=portfolio_id,
                amount=req.amount,
                as_of=req.asOf,
                note=req.note,
            )
            self.session.add(cb)
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, req.asOf
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, req.asOf, force_dates=force
        )
        return cb

    async def patch(
        self, portfolio_id: str, cb_id: str, req: CashBalancePatchReq
    ) -> CashBalance:
        cb = await self.get_scoped(CashBalance, cb_id, portfolio_id)
        old_as_of = cb.as_of
        if req.amount is not None:
            cb.amount = req.amount
        if req.note is not None:
            cb.note = req.note
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, old_as_of
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, old_as_of, force_dates=force
        )
        return cb

    async def delete(self, portfolio_id: str, cb_id: str) -> None:
        """净删除现金余额 + 重算 + 孤儿清理（与原路由一致：无 recalc 反馈）。"""
        cb = await self.get_scoped(CashBalance, cb_id, portfolio_id)
        d = cb.as_of
        await self.session.delete(cb)
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, d
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, d, force_dates=force
        )
        # 问题2：删除现金余额后清理残留 0 值孤儿 DERIVED 快照
        await AssetValuationService(self.session).prune_zero_orphans(portfolio_id, d)
        # prune 已不再内部重算：清理 0 值孤儿后需再重算一次 nav 链
        await RecalculationService(self.session).recalculateNavRange(portfolio_id, d)
