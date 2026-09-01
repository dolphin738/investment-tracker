"""总资产快照资源 Service — 对齐 app/ AssetSnapshotService。

从 routers/data.py 的 snapshots 路由内联逻辑抽出。继承 PortfolioChildService
复用 get_scoped。快照层写入经 AssetValuationService（C-11），重算经
RecalculationService.recalculateNavRange（T5，不重建快照层）。

注意：本 Service 返回 ORM 对象与派生总值（Decimal）的元组，序列化仍由 router
负责；list 的「MANUAL 行批量算 derived」属领域逻辑，放在本 Service。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import select

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import AssetSnapshot
from app.models.enums import SnapshotSource, SnapshotValuation
from app.schemas import SnapshotCreateReq, SnapshotPatchReq
from app.services.asset_valuation import AssetValuationService
from app.services.base import PortfolioChildService, validate_date_not_future, paged
from app.services.recalculation import RecalculationService


class SnapshotService(PortfolioChildService):
    async def list(
        self,
        portfolio_id: str,
        start: Optional[date] = None,
        end: Optional[date] = None,
        source: Optional[SnapshotSource] = None,
        page: int = 1,
        pageSize: int = 20,
    ) -> tuple[list[tuple[AssetSnapshot, Optional[Decimal]]], int]:
        """列表 + 分页；对 MANUAL 行批量计算 derivedTotalAsset（N+1 规避）。

        返回 [(snapshot, derived_total), ...] 与 total 计数。
        """
        base = select(AssetSnapshot).where(AssetSnapshot.portfolio_id == portfolio_id)
        if start:
            base = base.where(AssetSnapshot.date >= start)
        if end:
            base = base.where(AssetSnapshot.date <= end)
        # 缺陷7：来源筛选（DERIVED=自动 / MANUAL=手工），服务端过滤而非前端过滤
        if source:
            base = base.where(AssetSnapshot.source == source)
        # order_by 前移，保证 paged 内 limit/offset 的应用顺序与原内联一致
        base = base.order_by(AssetSnapshot.date.desc())
        rows, total = await paged(self.session, base, page, pageSize)
        # N+1 规避：仅对 MANUAL 行批量计算 derivedTotalAsset
        manual_dates = [r.date for r in rows if r.source is SnapshotSource.MANUAL]
        derived_map: dict[date, object] = {}
        if manual_dates:
            batch = await AssetValuationService(self.session).computeDerivedBatch(
                portfolio_id, manual_dates
            )
            derived_map = {d: b.total_asset for d, b in batch.items()}
        items = [
            (
                r,
                (
                    r.total_asset
                    if r.source is SnapshotSource.DERIVED
                    else derived_map.get(r.date)
                ),
            )
            for r in rows
        ]
        return items, total

    async def get_by_date(
        self, portfolio_id: str, snap_date: date
    ) -> tuple[AssetSnapshot, Decimal]:
        """按日期取快照（不存在→404）；返回 (快照, 派生总值)。"""
        snap = (
            await self.session.execute(
                select(AssetSnapshot).where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date == snap_date,
                )
            )
        ).scalar_one_or_none()
        if snap is None:
            raise BusinessException(
                code=BusinessErrorCode.NOT_FOUND,
                message="该日无总资产记录",
                status_code=404,
            )
        if snap.source is SnapshotSource.DERIVED:
            derived = snap.total_asset
        else:
            derived = (
                await AssetValuationService(self.session).computeDerived(
                    portfolio_id, snap_date
                )
            ).total_asset
        return snap, derived

    async def create(
        self, portfolio_id: str, req: SnapshotCreateReq
    ) -> tuple[AssetSnapshot, Decimal]:
        # D1：手工快照日期不能为未来（对齐 app/ snapshot upsert 的 validateDateNotFuture）
        validate_date_not_future(req.date)
        av = AssetValuationService(self.session)
        snap = await av.upsertManual(
            portfolio_id, req.date, req.totalAsset, req.marketValue,
            req.cashBalance, req.note,
        )
        await self.session.flush()
        await RecalculationService(self.session).recalculateNavRange(
            portfolio_id, req.date
        )
        derived = (
            await av.computeDerived(portfolio_id, req.date)
        ).total_asset
        return snap, derived

    async def bulk_upsert(
        self, portfolio_id: str, rows: list[dict]
    ) -> tuple[int, int]:
        """导入批量写入：手工快照批量 upsert，不 commit（由
        commit_import 末尾统一提交）；返回 (inserted, updated) 计数。

        与 REST 单条 create 收敛到同一 Service，消除导入路径的双真源；
        字段覆盖语义与 AssetValuationService._upsert_snapshot 一致
        （8 字段原地覆盖 + recorded_at），仅将逐行 SELECT 收敛为一次存量载入。
        """
        if not rows:
            return 0, 0
        parsed: list[tuple[date, Decimal, Optional[Decimal], Optional[Decimal], Optional[str]]] = []
        for r in rows:
            d = date.fromisoformat(r["date"])
            mv = Decimal(r["marketValue"]) if r.get("marketValue") else None
            cb = Decimal(r["cashBalance"]) if r.get("cashBalance") else None
            parsed.append((d, Decimal(r["totalAsset"]), mv, cb, r.get("note") or None))

        existing_rows = (
            await self.session.execute(
                select(AssetSnapshot).where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date.in_([d for d, *_ in parsed]),
                )
            )
        ).scalars().all()
        by_date = {s.date: s for s in existing_rows}

        recorded_at = datetime.now(timezone.utc)
        inserted = updated = 0
        for d, total, mv, cb, note in parsed:
            snap = by_date.get(d)
            if snap is not None:
                snap.total_asset = total
                snap.market_value = mv
                snap.cash_balance = cb
                snap.source = SnapshotSource.MANUAL
                snap.valuation_flag = SnapshotValuation.MANUAL_INPUT
                snap.note = note
                snap.recorded_at = recorded_at
                updated += 1
            else:
                self.session.add(
                    AssetSnapshot(
                        portfolio_id=portfolio_id,
                        date=d,
                        total_asset=total,
                        market_value=mv,
                        cash_balance=cb,
                        source=SnapshotSource.MANUAL,
                        valuation_flag=SnapshotValuation.MANUAL_INPUT,
                        note=note,
                        recorded_at=recorded_at,
                    )
                )
                inserted += 1
        await self.session.flush()
        return inserted, updated

    async def patch(
        self, portfolio_id: str, snap_id: str, req: SnapshotPatchReq
    ) -> tuple[AssetSnapshot, Decimal]:
        snap = await self.get_scoped(AssetSnapshot, snap_id, portfolio_id)
        old_date = snap.date
        # 合并补丁值：未提供的字段沿用原值
        total_asset = req.totalAsset if req.totalAsset is not None else snap.total_asset
        market_value = (
            req.marketValue if req.marketValue is not None else snap.market_value
        )
        cash_balance = (
            req.cashBalance if req.cashBalance is not None else snap.cash_balance
        )
        note = req.note if req.note is not None else snap.note
        # 经服务层写入（C-11），写入后由下方 recalculateNavRange 显式重算
        av = AssetValuationService(self.session)
        snap = await av.upsertManual(
            portfolio_id, old_date, total_asset, market_value, cash_balance, note,
        )
        await self.session.flush()
        await RecalculationService(self.session).recalculateNavRange(
            portfolio_id, old_date
        )
        derived = (await av.computeDerived(portfolio_id, old_date)).total_asset
        return snap, derived

    async def delete(self, portfolio_id: str, snap_id: str) -> None:
        """删除快照（不返回 recalc 反馈，与原路由一致）。"""
        snap = await self.get_scoped(AssetSnapshot, snap_id, portfolio_id)
        d = snap.date
        await AssetValuationService(self.session).deleteRecord(
            portfolio_id, d
        )
        await self.session.flush()
        await RecalculationService(self.session).recalculateNavRange(
            portfolio_id, d
        )

    async def reset(
        self, portfolio_id: str, snap_date: date
    ) -> tuple[AssetSnapshot, Decimal]:
        """手工快照回退为派生值（resetToDerived），返回 (快照, 派生总值)。"""
        av = AssetValuationService(self.session)
        snap = await av.resetToDerived(portfolio_id, snap_date)
        await self.session.flush()
        await RecalculationService(self.session).recalculateNavRange(
            portfolio_id, snap_date
        )
        return snap, snap.total_asset
