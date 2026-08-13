"""证券标的资源 Service — 对齐 app/ SecurityService。

从 routers/data.py 的 securities 路由内联逻辑抽出。继承 PortfolioChildService
复用 get_scoped 做归属隔离；删除前收集成交日并强制重算受影响 DERIVED 快照。

注意：本 Service 仅返回 ORM 对象与 RecalculationResult（删除有重算时），
序列化仍由 router 负责。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Security, SecurityTrade
from app.models.enums import SecurityType
from app.schemas import SecurityCreateReq, SecurityPatchReq, SecurityResolveReq
from app.services.base import PortfolioChildService, coerce_enum
from app.services.recalculation import RecalculationResult, RecalculationService


class SecurityService(PortfolioChildService):
    async def list_stmt(self, portfolio_id: str):
        """构造带排序的查询（分页交给 router 的 paginate）。"""
        return (
            select(Security)
            .where(Security.portfolio_id == portfolio_id)
            .order_by(Security.created_at.desc())
        )

    async def get(self, portfolio_id: str, sec_id: str) -> Security:
        """按 id 取标的并校验归属（404 不泄露存在性）。"""
        return await self.get_scoped(Security, sec_id, portfolio_id)

    async def create(self, portfolio_id: str, req: SecurityCreateReq) -> Security:
        sec = Security(
            portfolio_id=portfolio_id,
            code=req.code,
            name=req.name,
            type=coerce_enum(SecurityType, req.type, "type"),
            currency=req.currency,
        )
        self.session.add(sec)
        await self.session.commit()
        await self.session.refresh(sec)
        return sec

    async def patch(
        self, portfolio_id: str, sec_id: str, req: SecurityPatchReq
    ) -> Security:
        sec = await self.get_scoped(Security, sec_id, portfolio_id)
        if req.name is not None:
            sec.name = req.name
        if req.type is not None:
            sec.type = coerce_enum(SecurityType, req.type, "type")
        await self.session.commit()
        return sec

    async def resolve(
        self, portfolio_id: str, req: SecurityResolveReq
    ) -> tuple[Security, bool]:
        """幂等 upsert by (portfolio_id, code)：录入界面证券搜索选中后懒实例化为组合标的。

        返回 (security, is_new)。命中已有组合行 → is_new=False；否则新建（以主数据行模板或
        请求体兜底）→ is_new=True。
        """
        existing = (
            await self.session.execute(
                select(Security).where(
                    Security.portfolio_id == portfolio_id,
                    Security.code == req.code,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing, False

        # 以系统主数据行（portfolio_id IS NULL、同 code）为模板
        master = (
            await self.session.execute(
                select(Security).where(
                    Security.portfolio_id.is_(None),
                    Security.code == req.code,
                )
            )
        ).scalar_one_or_none()
        if master is not None:
            name = master.name
            stype = master.type
            exchange = master.exchange
        else:
            name = req.name or req.code
            stype = (
                coerce_enum(SecurityType, req.type, "type")
                if req.type
                else SecurityType.STOCK
            )
            exchange = req.exchange

        sec = Security(
            portfolio_id=portfolio_id,
            code=req.code,
            name=name,
            type=stype,
            currency="CNY",
            exchange=exchange,
        )
        self.session.add(sec)
        await self.session.commit()
        await self.session.refresh(sec)
        return sec, True

    async def delete(
        self, portfolio_id: str, sec_id: str
    ) -> RecalculationResult | None:
        """删除标的（级联删 trades/prices），若有成交日则强制重算受影响 DERIVED 快照。

        无成交日时无需重算，返回 None（保持原路由 delete 返回 null 的契约）。
        """
        sec = await self.get_scoped(Security, sec_id, portfolio_id)
        # 删除前收集该标的成交日（用于强制重算受影响 DERIVED 快照）
        trade_dates = (
            await self.session.execute(
                select(SecurityTrade.date).where(
                    SecurityTrade.portfolio_id == portfolio_id,
                    SecurityTrade.security_id == sec_id,
                )
            )
        ).scalars().all()
        await self.session.delete(sec)  # 级联删 trades/prices
        await self.session.commit()
        if trade_dates:
            return await RecalculationService(self.session).recalculateRange(
                portfolio_id, min(trade_dates), force_dates=sorted(set(trade_dates))
            )
        return None
