"""出入金（现金存款/取款）资源 Service — 对齐 app/ CashFlowService。

从 routers/data.py 的 cashflow 路由内联逻辑抽出；含 M1 首笔必须为存入校验、
写后重算触发、删除后孤儿清理。继承 PortfolioChildService 复用 get_scoped 做归属隔离。

注意：本 Service 仅返回 ORM 对象与 RecalculationResult，序列化仍由 router 负责
（与现有「router 序列化」约定一致，且避免 service 反向依赖 serializers）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import CashFlow, CashFlowType
from app.schemas import CashflowCreateReq, CashflowPatchReq
from app.services.asset_valuation import AssetValuationService
from app.services.base import PortfolioChildService, coerce_enum
from app.services.recalculation import RecalculationResult, RecalculationService


class CashflowService(PortfolioChildService):
    async def list_stmt(
        self, portfolio_id: str, start: date | None, end: date | None
    ):
        """构造带过滤/排序的查询（分页交给 router 的 paginate）。"""
        stmt = select(CashFlow).where(CashFlow.portfolio_id == portfolio_id)
        if start:
            stmt = stmt.where(CashFlow.date >= start)
        if end:
            stmt = stmt.where(CashFlow.date <= end)
        stmt = stmt.order_by(CashFlow.date.desc(), CashFlow.created_at.desc())
        return stmt

    async def get(self, portfolio_id: str, cf_id: str) -> CashFlow:
        """按 id 取出入金并校验归属（404 不泄露存在性）。"""
        return await self.get_scoped(CashFlow, cf_id, portfolio_id)

    async def assert_first_must_be_deposit(
        self, portfolio_id: str, rows: list[tuple[date, CashFlowType]]
    ) -> None:
        """D10：导入/批量场景的 M1 校验。rows 须按日期升序。

        若组合 DB 尚无任何 CashFlow，且某行为 SELL 且其前（DB+本批次更早行）无 BUY，则拒绝。
        与 create() 的 M1 口径一致，避免「UI 禁首笔取出、导入却可」的分裂。
        """
        db_has = (
            await self.session.execute(
                select(CashFlow.id)
                .where(CashFlow.portfolio_id == portfolio_id)
                .limit(1)
            )
        ).scalar_one_or_none() is not None
        seen_deposit = db_has
        for _d, t in rows:
            if t is CashFlowType.SELL and not seen_deposit:
                raise BusinessException(
                    BusinessErrorCode.VALIDATION_FAILED,
                    "首笔出入金必须为存入（买入），不能为取出（卖出）",
                    status_code=400,
                )
            if t is CashFlowType.BUY:
                seen_deposit = True

    async def create(
        self, portfolio_id: str, req: CashflowCreateReq
    ) -> tuple[CashFlow, RecalculationResult]:
        cf_type = coerce_enum(CashFlowType, req.type, "type")
        # M1：PRD §3.6 首笔出入金必须为存入；若组合尚无任何现金流且本次为取出，拒绝
        if cf_type is CashFlowType.SELL:
            has_existing = (
                await self.session.execute(
                    select(CashFlow.id)
                    .where(CashFlow.portfolio_id == portfolio_id)
                    .limit(1)
                )
            ).scalar_one_or_none()
            if has_existing is None:
                raise BusinessException(
                    BusinessErrorCode.VALIDATION_FAILED,
                    "首笔出入金必须为存入（买入），不能为取出（卖出）",
                    status_code=400,
                )
        cf = CashFlow(
            portfolio_id=portfolio_id,
            date=req.date,
            type=cf_type,
            amount=req.amount,
            note=req.note,
        )
        self.session.add(cf)
        await self.session.commit()
        rec = await RecalculationService(self.session).recalculateRange(
            portfolio_id, req.date
        )
        return cf, rec

    async def patch(
        self, portfolio_id: str, cf_id: str, req: CashflowPatchReq
    ) -> tuple[CashFlow, RecalculationResult]:
        cf = await self.get_scoped(CashFlow, cf_id, portfolio_id)
        old_date = cf.date
        if req.date is not None:
            cf.date = req.date
        if req.type is not None:
            cf.type = coerce_enum(CashFlowType, req.type, "type")
        if req.amount is not None:
            cf.amount = req.amount
        if req.note is not None:
            cf.note = req.note
        await self.session.commit()
        rec = await RecalculationService(self.session).recalculateRange(
            portfolio_id, min(cf.date, old_date)
        )
        return cf, rec

    async def delete(self, portfolio_id: str, cf_id: str) -> RecalculationResult:
        cf = await self.get_scoped(CashFlow, cf_id, portfolio_id)
        d = cf.date
        await self.session.delete(cf)
        await self.session.commit()
        rec = await RecalculationService(self.session).recalculateRange(portfolio_id, d)
        # 删除出入金后统一清理残留 0 值孤儿 DERIVED 快照（含删除日陈旧快照 + 区间内 0 值）
        await AssetValuationService(self.session).prune_zero_orphans(portfolio_id, d)
        # prune 已不再内部重算：清理 0 值孤儿后需再重算一次 nav 链，保证断链修复
        await RecalculationService(self.session).recalculateNavRange(portfolio_id, d)
        return rec

    async def bulk_create(
        self, portfolio_id: str, rows: list[dict]
    ) -> list[CashFlow]:
        """CSV/批量导入的现金流水写入（收口 data_transfer 原内联逻辑）。

        仅构造 + add，不 commit、不重算——事务提交与区间重算由 data_transfer
        在整批末尾统一编排，保持「全有或全无」语义。M1 首笔必须存入校验复用
        assert_first_must_be_deposit，消除与 REST 写入（create）的双真源（D10）。
        rows 每项含 date/type/amount/note；type 为 CashFlowType 的 value 字符串。
        """
        ordered = sorted(rows, key=lambda x: x["date"])
        await self.assert_first_must_be_deposit(
            portfolio_id,
            [(date.fromisoformat(r["date"]), CashFlowType(r["type"])) for r in ordered],
        )
        built: list[CashFlow] = []
        for r in rows:
            cf = CashFlow(
                portfolio_id=portfolio_id,
                date=date.fromisoformat(r["date"]),
                type=CashFlowType(r["type"]),
                amount=Decimal(r["amount"]),
                note=r.get("note") or None,
            )
            self.session.add(cf)
            built.append(cf)
        return built
