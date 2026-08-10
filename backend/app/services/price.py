"""最新价资源 Service — 对齐 app/ SecurityPriceService。

从 routers/data.py 的 security-prices 路由内联逻辑抽出；含同 as_of 的 upsert
（覆盖更新）。继承 PortfolioChildService 复用 get_scoped。

注意：本 Service 仅返回 ORM 对象，序列化仍由 router 负责。删除走「净删除 +
重算 + 孤儿清理」，与原路由一致（无 recalc 反馈）。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SecurityPrice
from app.schemas import PriceCreateReq, PricePatchReq
from app.services.asset_valuation import AssetValuationService
from app.services.base import PortfolioChildService, split_ids, validate_date_not_future
from app.services.recalculation import RecalculationService


class PriceService(PortfolioChildService):
    async def list_stmt(
        self, portfolio_id: str, security_id: Optional[str] = None
    ):
        """构造带过滤/排序的查询（分页交给 router 的 paginate）。"""
        stmt = select(SecurityPrice).where(SecurityPrice.portfolio_id == portfolio_id)
        if security_id:
            ids = split_ids(security_id)
            if ids:
                stmt = stmt.where(SecurityPrice.security_id.in_(ids))
        stmt = stmt.order_by(
            SecurityPrice.as_of.desc(), SecurityPrice.created_at.desc()
        )
        return stmt

    async def get(self, portfolio_id: str, price_id: str) -> SecurityPrice:
        """按 id 取现价并校验归属（404 不泄露存在性）。"""
        return await self.get_scoped(SecurityPrice, price_id, portfolio_id)

    async def create(self, portfolio_id: str, req: PriceCreateReq) -> SecurityPrice:
        # D1：日期不能为未来（对齐 app/ security-price upsert 的内联校验）
        validate_date_not_future(req.asOf)
        existing = (
            await self.session.execute(
                select(SecurityPrice).where(
                    SecurityPrice.portfolio_id == portfolio_id,
                    SecurityPrice.security_id == req.securityId,
                    SecurityPrice.as_of == req.asOf,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.price = req.price
            price = existing
        else:
            price = SecurityPrice(
                portfolio_id=portfolio_id,
                security_id=req.securityId,
                price=req.price,
                as_of=req.asOf,
            )
            self.session.add(price)
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, req.asOf
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, req.asOf, force_dates=force
        )
        return price

    async def patch(
        self, portfolio_id: str, price_id: str, req: PricePatchReq
    ) -> SecurityPrice:
        price = await self.get_scoped(SecurityPrice, price_id, portfolio_id)
        old_as_of = price.as_of
        if req.asOf is not None:
            validate_date_not_future(req.asOf)
        new_as_of = req.asOf if req.asOf is not None else price.as_of
        if req.price is not None:
            price.price = req.price
        if req.asOf is not None:
            price.as_of = req.asOf
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, min(new_as_of, old_as_of)
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, min(new_as_of, old_as_of), force_dates=force
        )
        return price

    async def delete(self, portfolio_id: str, price_id: str) -> None:
        """净删除现价 + 重算 + 孤儿清理（与原路由一致：无 recalc 反馈）。"""
        price = await self.get_scoped(SecurityPrice, price_id, portfolio_id)
        d = price.as_of
        await self.session.delete(price)
        await self.session.commit()
        force = await RecalculationService(self.session).snapshot_dates_since(
            portfolio_id, d
        )
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, d, force_dates=force
        )
        # 问题2：删除现价后清理残留 0 值孤儿 DERIVED 快照
        await AssetValuationService(self.session).prune_zero_orphans(portfolio_id, d)
        # prune 已不再内部重算：清理 0 值孤儿后需再重算一次 nav 链
        await RecalculationService(self.session).recalculateNavRange(portfolio_id, d)
