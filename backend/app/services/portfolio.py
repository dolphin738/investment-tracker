"""组合管理 Service — 对齐 app/ PortfolioService。

从 routers/portfolios.py 内联逻辑抽出。组合是顶层资源，归属隔离由 router 的
get_portfolio 依赖保证；本 Service 的方法接收已校验的 Portfolio 对象或 user_id。

含：列表/创建/改/删、清空数据（级联子表）、归档（同步清空偏好默认组合）、
设为默认（toggle）。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, select, update

from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    DailyNav,
    DailyXirr,
    DividendRecord,
    Portfolio,
    SecurityPrice,
    SecurityTrade,
    UserPreference,
)
from app.schemas import (
    PortfolioArchiveReq,
    PortfolioCreateReq,
    PortfolioPatchReq,
)
from app.services.base import PortfolioChildService


class PortfolioService(PortfolioChildService):
    async def list_for_user(self, user_id: str) -> list[Portfolio]:
        rows = (
            await self.session.execute(
                select(Portfolio)
                .where(Portfolio.user_id == user_id)
                .order_by(Portfolio.created_at.desc())
            )
        ).scalars().all()
        return list(rows)

    async def create(self, user_id: str, req: PortfolioCreateReq) -> Portfolio:
        p = Portfolio(
            user_id=user_id,
            name=req.name,
            description=req.description,
            currency=req.currency,
        )
        self.session.add(p)
        await self.session.commit()
        await self.session.refresh(p)
        return p

    async def patch(self, p: Portfolio, req: PortfolioPatchReq) -> Portfolio:
        if req.name is not None:
            p.name = req.name
        if req.description is not None:
            p.description = req.description
        await self.session.commit()
        return p

    async def delete(self, p: Portfolio) -> None:
        await self.session.delete(p)
        await self.session.commit()

    async def clear_data(self, p: Portfolio) -> dict[str, int]:
        """清空组合所有数据（保留组合本身）。级联删除子表。"""
        counts: dict[str, int] = {}
        for tbl in (
            DailyXirr,
            DailyNav,
            AssetSnapshot,
            CashFlow,
            DividendRecord,
            SecurityTrade,
            SecurityPrice,
            CashBalance,
        ):
            res = await self.session.execute(
                delete(tbl).where(tbl.portfolio_id == p.id)
            )
            counts[tbl.__tablename__] = int(res.rowcount or 0)
        await self.session.commit()
        return counts

    async def archive(self, p: Portfolio, req: PortfolioArchiveReq) -> Portfolio:
        """归档 / 取消归档（§4.2.2）。

        archived 缺省或 true → archivedAt = now；false → 置空。
        归档时若该组合为用户偏好默认组合，则同步置空。
        """
        archiving = req.archived is not False
        p.archived_at = datetime.now(timezone.utc) if archiving else None
        await self.session.commit()
        if archiving:
            await self.session.execute(
                update(UserPreference)
                .where(
                    UserPreference.user_id == p.user_id,
                    UserPreference.default_portfolio_id == p.id,
                )
                .values(default_portfolio_id=None)
            )
            await self.session.commit()
        return p

    async def set_default(
        self, p: Portfolio, user_id: str
    ) -> UserPreference:
        """五角星设为默认 / 再次点击取消默认（toggle）。"""
        pref = (
            await self.session.execute(
                select(UserPreference).where(UserPreference.user_id == user_id)
            )
        ).scalar_one_or_none()
        if pref is None:
            pref = UserPreference(user_id=user_id)
            self.session.add(pref)
        pref.default_portfolio_id = (
            None if pref.default_portfolio_id == p.id else p.id
        )
        await self.session.commit()
        await self.session.refresh(pref)
        return pref
