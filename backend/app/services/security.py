"""证券标的资源 Service — 对齐 app/ SecurityService（拆表后：目录表 + 组合持仓表）。

从 routers/data.py 的 securities 路由内联逻辑抽出。继承 PortfolioChildService
复用 get_scoped 做归属隔离；删除前收集成交日并强制重算受影响 DERIVED 快照。

组合行现为 ``portfolio_securities``（PortfolioSecurity）；目录表 ``securities`` 仅作
主数据搜索目录。resolve 按 (portfolio_id, master_id) 查/建组合行；type 经
``compute_type`` 在序列化层 COALESCE（override 优先，否则代码前缀推断）。

注意：本 Service 仅返回 ORM 对象与 RecalculationResult（删除有重算时），
序列化仍由 router 负责。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import (
    DividendRecord,
    PortfolioSecurity,
    Security,
    SecurityPrice,
    SecurityTrade,
)
from app.models.enums import SecurityType
from app.schemas import SecurityPatchReq, SecurityResolveReq
from app.services.base import PortfolioChildService, coerce_enum
from app.services.classification import infer_asset_class
from app.services.recalculation import RecalculationResult, RecalculationService


def infer_security_type(code: str, exchange: Optional[str] = None) -> SecurityType:
    """按代码前缀 + 交易所推断资产类型（主数据入库 / 组合持仓 type 共用）。

    规则已统一收敛到 ``app.services.classification.infer_asset_class``（单一事实来源），
    本函数仅作兼容别名，所有分类判断逻辑只在 classification 模块维护一份。
    """
    return infer_asset_class(code, exchange)


def compute_type(
    holding: PortfolioSecurity, master: Optional[Security] = None
) -> SecurityType:
    """组合行 type 推导（Python COALESCE，序列化层单一出口）。

    - holding.type 非空 → 手动 override 优先；
    - 否则按代码前缀推断（infer_security_type）；
    - master 未显式传入时回退到 holding.master 关系。
    """
    if holding.type is not None:
        # 重写 override 落库为枚举值字符串，回读时统一 coerce 回枚举，
        # 保证调用方（序列化 / 过滤）始终拿到 SecurityType，而非裸 str。
        return coerce_enum(SecurityType, holding.type, "type")
    if master is None:
        master = getattr(holding, "master", None)
    if master is not None:
        return infer_security_type(master.code, master.exchange)
    return SecurityType.STOCK


class SecurityService(PortfolioChildService):
    async def list_stmt(self, portfolio_id: str):
        """构造带排序的查询（分页交给 router 的 paginate）。"""
        return (
            select(PortfolioSecurity)
            .join(Security, PortfolioSecurity.master_id == Security.id)
            .where(PortfolioSecurity.portfolio_id == portfolio_id)
            .options(selectinload(PortfolioSecurity.master))
            .order_by(PortfolioSecurity.created_at.desc())
        )

    async def get(self, portfolio_id: str, sec_id: str) -> PortfolioSecurity:
        """按 id 取组合标的并校验归属（404 不泄露存在性）。"""
        holding = await self.get_scoped(PortfolioSecurity, sec_id, portfolio_id)
        await self.session.refresh(holding, ["master"])
        return holding

    async def patch(
        self, portfolio_id: str, sec_id: str, req: SecurityPatchReq
    ) -> PortfolioSecurity:
        """PATCH 组合标的：仅允许 type override（name 等维度归目录主数据）。"""
        holding = await self.get_scoped(PortfolioSecurity, sec_id, portfolio_id)
        if req.type is not None:
            holding.type = coerce_enum(SecurityType, req.type, "type")
        await self.session.commit()
        await self.session.refresh(holding, ["master"])
        return holding

    async def resolve(
        self, portfolio_id: str, req: SecurityResolveReq
    ) -> tuple[PortfolioSecurity, bool]:
        """幂等 upsert by (portfolio_id, master_id)：录入界面证券搜索选中后懒实例化为组合标的。

        返回 (holding, is_new)。命中已有组合行 → is_new=False；否则以目录主数据为模板新建
        组合行（type=NULL，读取时由 compute_type 按代码前缀推断）。
        """
        existing = (
            await self.session.execute(
                select(PortfolioSecurity).where(
                    PortfolioSecurity.portfolio_id == portfolio_id,
                    PortfolioSecurity.master_id == req.master_id,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await self.session.refresh(existing, ["master"])
            return existing, False

        master = await self.session.get(Security, req.master_id)
        if master is None:
            raise BusinessException(
                code=BusinessErrorCode.NOT_FOUND,
                message="证券主数据不存在",
                status_code=404,
            )
        holding = PortfolioSecurity(
            portfolio_id=portfolio_id,
            master_id=req.master_id,
            type=req.type,  # override；None=由代码前缀推断
            currency="CNY",
        )
        self.session.add(holding)
        await self.session.commit()
        await self.session.refresh(holding, ["master"])
        return holding, True

    async def delete(
        self, portfolio_id: str, sec_id: str
    ) -> RecalculationResult | None:
        """删除组合标的（级联删 trades/prices/dividends），若有成交日则强制重算受影响 DERIVED 快照。

        无成交日时无需重算，返回 None（保持原路由 delete 返回 null 的契约）。
        """
        holding = await self.get_scoped(PortfolioSecurity, sec_id, portfolio_id)
        # 删除前收集该标的成交日（用于强制重算受影响 DERIVED 快照）
        trade_dates = (
            await self.session.execute(
                select(SecurityTrade.date).where(
                    SecurityTrade.portfolio_id == portfolio_id,
                    SecurityTrade.security_id == sec_id,
                )
            )
        ).scalars().all()
        await self.session.delete(holding)  # 级联删 trades/prices/dividends
        await self.session.commit()
        if trade_dates:
            return await RecalculationService(self.session).recalculateRange(
                portfolio_id, min(trade_dates), force_dates=sorted(set(trade_dates))
            )
        return None

    async def prune_if_orphan(self, portfolio_id: str, security_id: str) -> bool:
        """删除某证券的子记录（买卖/行情/分红）后，若该组合持仓已无任何子数据则连持仓一起删（实现B）。

        持仓是组合下"触碰过此证券"的指针；仅当 ``trades=0 AND prices=0 AND dividends=0``
        时才算纯孤儿。删除持仓不影响估值（估值只读取 trades/prices/dividends，持仓本身
        不参与计算），故调用方无需额外重算。返回是否真删除了持仓。
        """
        n_trades = (
            await self.session.execute(
                select(func.count())
                .select_from(SecurityTrade)
                .where(SecurityTrade.security_id == security_id)
            )
        ).scalar_one()
        n_prices = (
            await self.session.execute(
                select(func.count())
                .select_from(SecurityPrice)
                .where(SecurityPrice.security_id == security_id)
            )
        ).scalar_one()
        n_div = (
            await self.session.execute(
                select(func.count())
                .select_from(DividendRecord)
                .where(DividendRecord.security_id == security_id)
            )
        ).scalar_one()
        if n_trades == 0 and n_prices == 0 and n_div == 0:
            holding = await self.get_scoped(PortfolioSecurity, security_id, portfolio_id)
            await self.session.delete(holding)
            await self.session.commit()
            return True
        return False
