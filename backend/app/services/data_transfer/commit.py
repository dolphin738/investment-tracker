"""数据导入导出 —— 导入提交（单事务 + 单次重算）。"""

from __future__ import annotations

from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.schemas_resp import ImportRowError
from app.services.cashflow import CashflowService
from app.services.recalculation import RecalculationService
from app.services.snapshot import SnapshotService
from app.services.trade import TradeService

__all__ = ["commit_import"]


async def commit_import(
    db: AsyncSession,
    type_: str,
    portfolio_id: str,
    rows: list[dict],
    min_date: str | None,
) -> dict:
    inserted = updated = skipped = 0
    failed: list[ImportRowError] = []

    if type_ == "securityTrades":
        # 收口：证券买卖批量写入统一走 TradeService（卖出硬校验 + 构造），
        # 不再在导入层直接构造 ORM 模型，消除与 REST 写入的双真源（D10）。
        inserted += await TradeService(db).bulk_create(portfolio_id, rows)
    elif type_ == "cashFlows":
        # 收口：现金流水批量写入统一走 CashflowService（M1 校验 + 构造），
        # 不再在导入层直接构造 ORM 模型，消除与 REST 写入的双真源（D10）。
        await CashflowService(db).bulk_create(portfolio_id, rows)
        inserted += len(rows)
    elif type_ == "assetSnapshots":
        # 收口：总资产快照批量 upsert 统一走 SnapshotService（与 REST 单条 create 同源），
        # 不再在导入层直接调 AssetValuationService + 内联 select 计数（D10）。
        ins, upd = await SnapshotService(db).bulk_upsert(portfolio_id, rows)
        inserted += ins
        updated += upd

    await db.commit()

    recalculated = None
    if min_date:
        start_date = date.fromisoformat(min_date)
        if type_ == "assetSnapshots":
            # T5: only calculation layer cascade
            days = await RecalculationService(db).recalculateNavRange(
                portfolio_id, start_date
            )
        else:
            # T1-T4: snapshot layer rebuild + calculation layer cascade
            force = await RecalculationService(db).snapshot_dates_since(
                portfolio_id, start_date
            )
            days = await RecalculationService(db).recalculateRange(
                portfolio_id, start_date, force_dates=force
            )
        recalculated = {
            "fromDate": min_date,
            "toDate": today_app_tz().isoformat(),
            "recalculatedDays": days.affected_days,
        }
    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
        "recalculated": recalculated,
    }
