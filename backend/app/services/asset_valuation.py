"""总资产派生层（方案B 核心）— 对齐 docs/ARCHITECTURE.md §8。

定位：asset_snapshots(source='DERIVED') 的唯一写入方。把「持仓市值（流水回放）
+ 现金余额」聚合为每日总资产并落库；计算引擎只读 AssetSnapshot（C-08′）。

写入分两类：
- 派生路径 persistDerived：遇当日 MANUAL 跳过、不覆盖（双保险②）。
- 手工三路径 upsertManual / deleteRecord / resetToDerived：无条件覆盖当日一行，
  不再反向调用 recalculateNavRange；重算由调用方经 RecalculationService 显式编排
  （单向依赖：recalculation → valuation，valuation 不再依赖 recalculation）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.finance_core.holding import ZERO
from app.models import (
    AssetSnapshot,
    CashBalance,
    DailyNav,
    DailyXirr,
    SecurityPrice,
    SecurityTrade,
    SnapshotSource,
    SnapshotValuation,
)
from app.services.holding import HoldingService


@dataclass
class DerivedResult:
    total_asset: Decimal
    market_value: Decimal
    cash_balance: Decimal
    valuation_flag: SnapshotValuation


class AssetValuationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── 纯计算：系统本应算出多少 ──
    async def computeDerived(self, portfolio_id: str, d: date) -> DerivedResult:
        holdings = await HoldingService(self.session).derive(
            portfolio_id, d, include_closed=True
        )
        market_value = sum((h.market_value for h in holdings), ZERO)
        cash = await self._latest_cash_balance(portfolio_id, d)
        # 现金余额缺失（仅入金、尚未登记现金头寸）时按 0 计，flag 落 CARRIED_FORWARD
        cash_or_zero = cash if cash is not None else ZERO
        total = market_value + cash_or_zero
        flag = self._valuation_flag(holdings, cash is not None)
        return DerivedResult(
            total_asset=total,
            market_value=market_value,
            cash_balance=cash,
            valuation_flag=flag,
        )

    async def computeDerivedBatch(
        self, portfolio_id: str, dates: list[date]
    ) -> dict[date, DerivedResult]:
        """批量派生：N 日恒 3 次查库（trades/prices/cashbalances），规避 N+1。

        对齐 §8.1 computeDerivedBatch：配合 HoldingDerivationService 按日分组回放。
        """
        if not dates:
            return {}
        max_d = max(dates)
        trades = (
            await self.session.execute(
                select(SecurityTrade).where(
                    SecurityTrade.portfolio_id == portfolio_id,
                    SecurityTrade.date <= max_d,
                )
            )
        ).scalars().all()
        prices = (
            await self.session.execute(
                select(SecurityPrice).where(
                    SecurityPrice.portfolio_id == portfolio_id,
                    SecurityPrice.as_of <= max_d,
                )
            )
        ).scalars().all()
        cash_rows = (
            await self.session.execute(
                select(CashBalance)
                .where(
                    CashBalance.portfolio_id == portfolio_id,
                    CashBalance.as_of <= max_d,
                )
                .order_by(
                    CashBalance.as_of, CashBalance.created_at, CashBalance.id
                )
            )
        ).scalars().all()

        held = {}
        for t in trades:
            held.setdefault(t.security_id, []).append(t)
        price_best: dict[str, tuple[date, Decimal]] = {}
        for p in prices:
            cur = price_best.get(p.security_id)
            if cur is None or p.as_of > cur[0]:
                price_best[p.security_id] = (p.as_of, p.price)
        # L5：同 as_of 多条现金余额时，确定性取最新创建（created_at,id 最大）一行，
        # 与 _latest_cash_balance 的 as_of.desc()+created_at.desc()+id.desc() 口径一致。
        cash_best: dict[date, CashBalance] = {}
        for c in cash_rows:
            cur = cash_best.get(c.as_of)
            if cur is None or (c.created_at, c.id) > (cur.created_at, cur.id):
                cash_best[c.as_of] = c

        out: dict[date, DerivedResult] = {}
        for d in dates:
            out[d] = self._compute_one(d, held, price_best, cash_best)
        return out

    # ── 落库：DERIVED 写入（遇 MANUAL 跳过）──
    async def persistDerived(self, portfolio_id: str, d: date) -> int:
        existing = await self._get_snapshot(portfolio_id, d)
        if existing is not None and existing.source is SnapshotSource.MANUAL:
            return 1  # 双保险②：不覆盖手工，记 1 天（供 recalculateRange 统计 skippedManualDays，修复 D3）
        derived = await self.computeDerived(portfolio_id, d)
        if existing is not None:
            existing.total_asset = derived.total_asset
            existing.market_value = derived.market_value
            existing.cash_balance = derived.cash_balance
            existing.source = SnapshotSource.DERIVED
            existing.valuation_flag = derived.valuation_flag
            existing.recorded_at = datetime.now(timezone.utc)
        else:
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            stmt = pg_insert(AssetSnapshot.__table__).values(
                portfolio_id=portfolio_id,
                date=d,
                total_asset=derived.total_asset,
                market_value=derived.market_value,
                cash_balance=derived.cash_balance,
                source=SnapshotSource.DERIVED,
                valuation_flag=derived.valuation_flag,
                note=None,
                recorded_at=datetime.now(timezone.utc),
            ).on_conflict_do_nothing(
                index_elements=["portfolio_id", "date"]
            )
            await self.session.execute(stmt)
        return 0

    # ── 落库：手工三路径 ──
    async def _upsert_snapshot(
        self,
        portfolio_id: str,
        d: date,
        *,
        total_asset: Decimal,
        market_value: Decimal | None,
        cash_balance: Decimal | None,
        note: str | None,
        source: SnapshotSource,
        valuation_flag: SnapshotValuation,
    ) -> AssetSnapshot:
        """existing 则原地改 8 字段，否则新建；统一录制 recorded_at。

        upsertManual / resetToDerived 同构骨架收敛点（REP-036）。
        """
        existing = await self._get_snapshot(portfolio_id, d)
        if existing is not None:
            existing.total_asset = total_asset
            existing.market_value = market_value
            existing.cash_balance = cash_balance
            existing.source = source
            existing.valuation_flag = valuation_flag
            existing.note = note
            existing.recorded_at = datetime.now(timezone.utc)
            return existing
        snap = AssetSnapshot(
            portfolio_id=portfolio_id,
            date=d,
            total_asset=total_asset,
            market_value=market_value,
            cash_balance=cash_balance,
            source=source,
            valuation_flag=valuation_flag,
            note=note,
            recorded_at=datetime.now(timezone.utc),
        )
        self.session.add(snap)
        return snap

    async def upsertManual(
        self,
        portfolio_id: str,
        d: date,
        total_asset: Decimal,
        market_value: Decimal | None,
        cash_balance: Decimal | None,
        note: str | None,
    ) -> AssetSnapshot:
        return await self._upsert_snapshot(
            portfolio_id,
            d,
            total_asset=total_asset,
            market_value=market_value,
            cash_balance=cash_balance,
            note=note,
            source=SnapshotSource.MANUAL,
            valuation_flag=SnapshotValuation.MANUAL_INPUT,
        )

    async def resetToDerived(
        self, portfolio_id: str, d: date
    ) -> AssetSnapshot:
        """↺ 重置为自动值：原地覆盖该行（非删除），source 置回 DERIVED。"""
        derived = await self.computeDerived(portfolio_id, d)
        return await self._upsert_snapshot(
            portfolio_id,
            d,
            total_asset=derived.total_asset,
            market_value=derived.market_value,
            cash_balance=derived.cash_balance,
            note=None,
            source=SnapshotSource.DERIVED,
            valuation_flag=derived.valuation_flag,
        )

    async def deleteRecord(
        self, portfolio_id: str, d: date
    ) -> None:
        """事务内三删：快照 + daily_nav + daily_xirr（避免幽灵 prevNav）。

        重算由调用方显式编排（RecalculationService），本方法不再反向依赖 recalc。
        """
        await self.session.execute(
            delete(AssetSnapshot).where(
                AssetSnapshot.portfolio_id == portfolio_id,
                AssetSnapshot.date == d,
            )
        )
        await self.session.execute(
            delete(DailyNav).where(
                DailyNav.portfolio_id == portfolio_id, DailyNav.date == d
            )
        )
        await self.session.execute(
            delete(DailyXirr).where(
                DailyXirr.portfolio_id == portfolio_id, DailyXirr.date == d
            )
        )
        # 若当日（或之前）仍存在可派生的底层数据 → 立即回填 DERIVED 自动记录，
        # 否则留空（读路径前值填充）。修复缺陷5：删除手工快照后，即便当日无事件、
        # 但历史存在交易/现金/行情/出入金，也必须补回当日自动记录，保障 XIRR/净值链完整。
        if await self.has_any_event_upto(portfolio_id, d):
            await self.persistDerived(portfolio_id, d)

    async def _delete_derived_day(self, portfolio_id: str, d: date) -> None:
        """事务内三删：DERIVED 快照 + daily_nav + daily_xirr（避免幽灵 prevNav）。"""
        await self.session.execute(
            delete(AssetSnapshot).where(
                AssetSnapshot.portfolio_id == portfolio_id,
                AssetSnapshot.date == d,
                AssetSnapshot.source == SnapshotSource.DERIVED,
            )
        )
        await self.session.execute(
            delete(DailyNav).where(
                DailyNav.portfolio_id == portfolio_id, DailyNav.date == d
            )
        )
        await self.session.execute(
            delete(DailyXirr).where(
                DailyXirr.portfolio_id == portfolio_id, DailyXirr.date == d
            )
        )

    async def prune_zero_orphans(self, portfolio_id: str, since: date) -> None:
        """统一清理删除后残留的孤儿 DERIVED 快照（问题2）。

        两类孤儿：
        - 删除日 since 已不再含任何事件 → 其 DERIVED 快照陈旧（即便非 0，如删买卖后
          仍残留含费成本估值的快照）应删除；
        - 区间内任一「0 值」DERIVED（total_asset == 0）：包括「仍为事件日但仅余出入金→0」
          （如删现金余额后当日只剩出入金）以及「今日 0 值快照」。0 值快照不携带任何
          信息，恒为删除产物。

        清理后需由调用方显式重算 [since, today] 的 NAV/XIRR（通常在调用本方法前已
        经 RecalculationService.recalculateRange 覆盖，故此处不再反向依赖 recalc）。
        """
        today = today_app_tz()
        # ① 删除日若已非事件日 → 删其 DERIVED（陈旧即便非 0）
        if not await self._is_event_date(portfolio_id, since):
            await self._delete_derived_day(portfolio_id, since)
        # ② 区间内任一 0 值 DERIVED（即便仍是事件日 / 含今日）
        zero_rows = (
            await self.session.execute(
                select(AssetSnapshot).where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date >= since,
                    AssetSnapshot.date <= today,
                    AssetSnapshot.source == SnapshotSource.DERIVED,
                    AssetSnapshot.total_asset == ZERO,
                )
            )
        ).scalars().all()
        for snap in zero_rows:
            await self._delete_derived_day(portfolio_id, snap.date)

    # ── 内部工具 ──
    async def _get_snapshot(
        self, portfolio_id: str, d: date
    ) -> AssetSnapshot | None:
        return (
            await self.session.execute(
                select(AssetSnapshot).where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date == d,
                )
            )
        ).scalar_one_or_none()

    async def _latest_cash_balance(
        self, portfolio_id: str, d: date
    ) -> Decimal | None:
        row = (
            await self.session.execute(
                select(CashBalance)
                .where(
                    CashBalance.portfolio_id == portfolio_id,
                    CashBalance.as_of <= d,
                )
                .order_by(
                    CashBalance.as_of.desc(),
                    CashBalance.created_at.desc(),
                    CashBalance.id.desc(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        return row.amount if row is not None else None

    def _valuation_flag(self, holdings: list, cash_exists: bool) -> SnapshotValuation:
        if any(h.is_cost_based for h in holdings if h.quantity != ZERO):
            return SnapshotValuation.COST_BASED
        if cash_exists:
            return SnapshotValuation.EXACT
        return SnapshotValuation.CARRIED_FORWARD

    def _compute_one(
        self,
        d: date,
        held: dict[str, list],
        price_best: dict[str, tuple[date, Decimal]],
        cash_best: dict[date, CashBalance],
    ) -> DerivedResult:
        from app.finance_core.holding import (
            HoldingView,
            TradeInput,
            derive_holdings,
        )

        inputs: list[TradeInput] = []
        for sec_id, ts in held.items():
            for t in ts:
                if t.date <= d:
                    inputs.append(
                        TradeInput(
                            security_id=t.security_id,
                            date=t.date,
                            created_at=t.created_at,
                            side=t.side,
                            quantity=t.quantity,
                            cost_price=t.cost_price,
                            fee_total=t.fee_total,
                        )
                    )
        prices: dict[str, Decimal | None] = {}
        for sec_id, (as_of, price) in price_best.items():
            prices[sec_id] = price if as_of <= d else None
        views: list[HoldingView] = derive_holdings(inputs, prices)
        market_value = sum((h.market_value for h in views), ZERO)
        # 取 ≤d 的最后一条现金余额
        cash = ZERO
        cash_exists = False
        for as_of in sorted(cash_best.keys()):
            if as_of <= d:
                cash = cash_best[as_of].amount or ZERO
                cash_exists = True
            else:
                break
        total = market_value + cash
        flag = self._valuation_flag(views, cash_exists)
        return DerivedResult(
            total_asset=total,
            market_value=market_value,
            cash_balance=cash,
            valuation_flag=flag,
        )

    async def _is_event_date(self, portfolio_id: str, d: date) -> bool:
        for tbl, col in (
            (SecurityTrade, SecurityTrade.date),
            (CashBalance, CashBalance.as_of),
            (SecurityPrice, SecurityPrice.as_of),
        ):
            exists = (
                await self.session.execute(
                    select(tbl.id).where(tbl.portfolio_id == portfolio_id, col == d).limit(1)
                )
            ).first()
            if exists is not None:
                return True
        from app.models import CashFlow

        exists = (
            await self.session.execute(
                select(CashFlow.id)
                .where(CashFlow.portfolio_id == portfolio_id, CashFlow.date == d)
                .limit(1)
            )
        ).first()
        return exists is not None

    async def has_any_event_upto(
        self, portfolio_id: str, d: date
    ) -> bool:
        """是否存在任何事件（交易/现金/行情/出入金）日期 ≤ d。

        用于删除手工快照后判断当日是否仍可派生自动记录：只要组合在 d 当日或之前
        有过任何数据，当日就应有 DERIVED 自动快照（由历史数据向前沿用），删除手工
        记录后必须补回，保障 XIRR/净值链不断（修复缺陷5）。与 ``_is_event_date``
        （要求事件恰好落在 d）不同，本方法用 ``<= d`` 放宽到「历史存在即可」。
        """
        for tbl, col in (
            (SecurityTrade, SecurityTrade.date),
            (CashBalance, CashBalance.as_of),
            (SecurityPrice, SecurityPrice.as_of),
        ):
            exists = (
                await self.session.execute(
                    select(tbl.id)
                    .where(tbl.portfolio_id == portfolio_id, col <= d)
                    .limit(1)
                )
            ).first()
            if exists is not None:
                return True
        from app.models import CashFlow

        exists = (
            await self.session.execute(
                select(CashFlow.id)
                .where(CashFlow.portfolio_id == portfolio_id, CashFlow.date <= d)
                .limit(1)
            )
        ).first()
        return exists is not None
