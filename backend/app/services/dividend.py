"""分红记录资源 Service — 对齐 app/ DividendService。

从 routers/dividend.py 内联逻辑抽出。继承 PortfolioChildService 复用 get_scoped
做归属/二级隔离；分红不参与收益计算（C-08/D-02）：不写 CashFlow、不触发重算引擎。

注意：本 Service 仅返回 ORM 对象与 (rows, total)，序列化（含标的信息映射）
仍由 router 负责。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import DividendRecord, Security
from app.models.enums import DividendType
from app.schemas import DividendCreateReq, DividendPatchReq
from app.services.base import PortfolioChildService, coerce_enum, split_ids


class DividendService(PortfolioChildService):
    async def list(
        self,
        portfolio_id: str,
        security_id: Optional[str] = None,
        start: Optional[date] = None,
        end: Optional[date] = None,
        page: int = 1,
        pageSize: int = 50,
    ) -> tuple[list[DividendRecord], int]:
        """列表 + 分页（标的信息映射与序列化留在 router）。"""
        stmt = select(DividendRecord).where(DividendRecord.portfolio_id == portfolio_id)
        if security_id:
            ids = split_ids(security_id)
            if ids:
                stmt = stmt.where(DividendRecord.security_id.in_(ids))
        if start:
            stmt = stmt.where(DividendRecord.date >= start)
        if end:
            stmt = stmt.where(DividendRecord.date <= end)
        stmt = stmt.order_by(
            DividendRecord.date.desc(), DividendRecord.created_at.desc()
        )
        total = (
            await self.session.execute(
                select(func.count()).select_from(stmt.subquery())
            )
        ).scalar_one()
        rows = (
            await self.session.execute(
                stmt.limit(pageSize).offset((page - 1) * pageSize)
            )
        ).scalars().all()
        return rows, total

    async def get(self, portfolio_id: str, div_id: str) -> DividendRecord:
        """按 id 取分红并校验归属（404 不泄露存在性）。"""
        return await self.get_scoped(DividendRecord, div_id, portfolio_id)

    async def create(
        self, portfolio_id: str, req: DividendCreateReq
    ) -> DividendRecord:
        # 二级隔离：证券必须属于本组合
        await self.get_scoped(Security, req.securityId, portfolio_id)
        tax = req.tax if req.tax is not None else Decimal(0)
        # netAmount = amount - tax 不能为负（K-2）
        if req.amount - tax < 0:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message="净额（amount - tax）不能为负",
                status_code=400,
            )
        d = DividendRecord(
            portfolio_id=portfolio_id,
            security_id=req.securityId,
            date=req.date,
            amount=req.amount,
            tax=tax,
            type=(
                coerce_enum(DividendType, req.type, "type")
                if req.type is not None
                else DividendType.CASH
            ),
            note=req.note,
        )
        self.session.add(d)
        await self.session.commit()
        await self.session.refresh(d)
        return d

    async def patch(
        self, portfolio_id: str, div_id: str, req: DividendPatchReq
    ) -> DividendRecord:
        d = await self.get_scoped(DividendRecord, div_id, portfolio_id)
        sec_id = d.security_id
        amount = d.amount
        tax = d.tax
        if req.securityId is not None:
            # 二级隔离：新证券必须属于本组合
            await self.get_scoped(Security, req.securityId, portfolio_id)
            sec_id = req.securityId
        if req.date is not None:
            d.date = req.date
        if req.amount is not None:
            amount = req.amount
        if req.tax is not None:
            tax = req.tax
        if req.type is not None:
            d.type = coerce_enum(DividendType, req.type, "type")
        if req.note is not None:
            d.note = req.note
        d.security_id = sec_id
        d.amount = amount
        d.tax = tax
        if d.amount - d.tax < 0:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message="净额（amount - tax）不能为负",
                status_code=400,
            )
        await self.session.commit()
        await self.session.refresh(d)
        return d

    async def delete(self, portfolio_id: str, div_id: str) -> None:
        d = await self.get_scoped(DividendRecord, div_id, portfolio_id)
        await self.session.delete(d)
        await self.session.commit()
