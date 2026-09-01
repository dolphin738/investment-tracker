"""计算触发器（五类触发 → 统一入口）— 对齐 docs/ARCHITECTURE.md §7.3。

对外两个入口：
- recalculateRange(portfolio_id, start, end?)：T1~T4 用。快照层区间重建
  （DELETE DERIVED + 逐事件日 persistDerived）+ 计算层级联。
- recalculateNavRange(portfolio_id, start, end?)：T5 用。只做计算层级联，不碰快照层。

end 缺省 = today（UTC+8），绝非 start（PRD §5.4.4）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    SecurityPrice,
    SecurityTrade,
    SnapshotSource,
)
from app.services.asset_valuation import AssetValuationService
from app.services.calculation import CalculationService


@dataclass
class RecalculationResult:
    """重算反馈（完整对齐 app/ 的 RecalculationMeta：fromDate/affectedDays/skippedManualDays）。"""

    from_date: date
    affected_days: int
    skipped_manual_days: int


class RecalculationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def recalculateNavRange(
        self, portfolio_id: str, start: date, end: date | None = None
    ) -> RecalculationResult:
        """T5 入口：只做 NAV/XIRR 层级联（不碰快照层）。范围 [start, today]。

        与 recalculateRange 统一返回 RecalculationResult（skippedManualDays 恒 0，
        因 T5 不重建快照层、无 MANUAL 跳过），以便 commit_import 的 shared
        `recalculated` 字典对两条分支都用 days.affected_days。
        """
        until = end or today_app_tz()
        affected_days = await CalculationService(self.session).compute_range(
            portfolio_id, start, until
        )
        return RecalculationResult(
            from_date=start,
            affected_days=affected_days,
            skipped_manual_days=0,
        )

    async def recalculateRange(
        self,
        portfolio_id: str,
        start: date,
        end: date | None = None,
        force_dates: list[date] | None = None,
    ) -> RecalculationResult:
        """T1~T4 入口：快照区间重建 + NAV/XIRR 层级联。范围 [start, today]。

        force_dates：显式并入事件日集合（用于成交/现价/现金余额改动需向前沿用、
        或删除标的后需重建受影响日 DERIVED 的场景）。
        返回 RecalculationResult（完整对齐 app/ 的 recalculation 反馈字段，修复 D3）。
        """
        until = end or today_app_tz()
        event_dates = await self._get_event_dates(portfolio_id, start, until)
        if force_dates:
            event_dates = sorted(set(event_dates) | set(force_dates))
        # ① DELETE 区间内所有 DERIVED（双保险①：不误删 MANUAL）
        if event_dates:
            await self.session.execute(
                delete(AssetSnapshot)
                .where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date.in_(event_dates),
                    AssetSnapshot.source == SnapshotSource.DERIVED,
                )
            )
        # ② 批量重派生（双保险②：MANUAL 跳过不覆盖，语义与 persistDerived 对齐）。
        #    复用 computeDerivedBatch（N 日恒 3 次查库）替代逐事件日 persistDerived
        #    （每日约 5 次查询 + 累积扫描），区间重建查询数从 O(5D) 降为常数级；
        #    写入合并为单条多值 INSERT ... ON CONFLICT DO NOTHING（步骤①已删除
        #    区间内 DERIVED，此处仅剩插入与 MANUAL 跳过两种情形）。
        av = AssetValuationService(self.session)
        skipped_manual_days = 0
        if event_dates:
            derived_map = await av.computeDerivedBatch(portfolio_id, event_dates)
            manual_dates = set(
                (
                    await self.session.execute(
                        select(AssetSnapshot.date).where(
                            AssetSnapshot.portfolio_id == portfolio_id,
                            AssetSnapshot.date.in_(event_dates),
                            AssetSnapshot.source == SnapshotSource.MANUAL,
                        )
                    )
                ).scalars().all()
            )
            skipped_manual_days = len(manual_dates)
            values = [
                {
                    "portfolio_id": portfolio_id,
                    "date": d,
                    "total_asset": derived_map[d].total_asset,
                    "market_value": derived_map[d].market_value,
                    "cash_balance": derived_map[d].cash_balance,
                    "source": SnapshotSource.DERIVED,
                    "valuation_flag": derived_map[d].valuation_flag,
                    "note": None,
                    "recorded_at": datetime.now(timezone.utc),
                }
                for d in event_dates
                if d not in manual_dates
            ]
            if values:
                await self.session.execute(
                    pg_insert(AssetSnapshot.__table__)
                    .values(values)
                    .on_conflict_do_nothing(
                        index_elements=["portfolio_id", "date"]
                    )
                )
        await self.session.flush()
        # ③ 按「快照日期集合」逐日重算 NAV→XIRR
        nav_result = await self.recalculateNavRange(portfolio_id, start, until)
        return RecalculationResult(
            from_date=start,
            affected_days=nav_result.affected_days,
            skipped_manual_days=skipped_manual_days,
        )

    async def snapshot_dates_since(
        self, portfolio_id: str, since: date
    ) -> list[date]:
        """返回 ≥ since 的全部快照日期（向前沿用场景的强制重算范围）。"""
        rows = (
            await self.session.execute(
                select(AssetSnapshot.date).where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date >= since,
                )
            )
        ).scalars().all()
        return sorted(set(rows))

    async def _get_event_dates(
        self, portfolio_id: str, start: date, until: date
    ) -> list[date]:
        dates: set[date] = set()
        for tbl, col in (
            (SecurityTrade, SecurityTrade.date),
            (CashFlow, CashFlow.date),
            (SecurityPrice, SecurityPrice.as_of),
            (CashBalance, CashBalance.as_of),
        ):
            rows = (
                await self.session.execute(
                    select(col).where(
                        tbl.portfolio_id == portfolio_id,
                        col >= start,
                        col <= until,
                    )
                )
            ).scalars().all()
            dates.update(rows)
        # 区间端点：仅当区间内【存在事件】时才把今日并入，避免「全部删除后」
        # 仍派生一条 0 值今日 DERIVED 快照（孤儿记录，污染概览/总资产）。
        # 若区间内无任何事件（如删除了最后一笔出入金/买卖/现价/现金），
        # 则不生成任何 DERIVED 快照，由删除路径的 prune_zero_orphans 兜底清理残留。
        if dates:
            dates.add(until)
        return sorted(dates)
