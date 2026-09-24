"""用户级行情自动同步（每用户独立配置，只同步本人组合；不写 job_run_logs）。

``_running_user_syncs`` 共享集合提供 cron 与手动触发的并发去重，避免重复堆叠。
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.bg import track_task
from app.db.database import AsyncSessionLocal
from app.models import Portfolio, UserQuoteSyncConfig
from app.services.market_data_sync import MarketDataSyncService

from ._state import _running_user_syncs


async def _run_user_quote_sync(user_id: str) -> None:
    """按用户配置同步其本人所属全部组合行情，并回写执行状态到 user_quote_sync_configs。

    逐组合用独立会话同步 + 提交；**单组合失败仅记录、不中断其余组合**；
    全部成功 → SUCCESS + "已同步 N 个组合"，任一失败 → FAILED + 错误摘要。
    执行结果不回写 job_run_logs。同一用户重复触发（手动连点/cron 撞上手动）直接跳过。
    """
    if user_id in _running_user_syncs:
        return
    _running_user_syncs.add(user_id)
    try:
        async with AsyncSessionLocal() as session:
            portfolio_ids = (
                await session.execute(
                    select(Portfolio.id).where(Portfolio.user_id == user_id)
                )
            ).scalars().all()
        count = 0
        errors: list[str] = []
        for pid in portfolio_ids:
            try:
                async with AsyncSessionLocal() as s:
                    await MarketDataSyncService(s).sync_portfolio_prices(pid)
                    await s.commit()
                count += 1
            except Exception as exc:  # 单组合失败不中断其余组合
                errors.append(f"{pid}: {exc}")
        async with AsyncSessionLocal() as session:
            cfg = await session.get(UserQuoteSyncConfig, user_id)
            if cfg is not None:
                cfg.last_run_at = datetime.now(timezone.utc)
                if not errors:
                    cfg.last_status = "SUCCESS"
                    cfg.last_message = f"已同步 {count} 个组合"
                else:
                    cfg.last_status = "FAILED"
                    cfg.last_message = (
                        f"同步 {count}/{len(portfolio_ids)} 个组合成功；"
                        f"失败明细：{'；'.join(errors)}"[:512]
                    )
                await session.commit()
    finally:
        _running_user_syncs.discard(user_id)


def run_user_sync_now(user_id: str) -> None:
    """用户手动立即触发自己的行情同步：直接调度 _run_user_quote_sync，不依赖全局调度器。"""
    track_task(asyncio.get_running_loop().create_task(_run_user_quote_sync(user_id)))
