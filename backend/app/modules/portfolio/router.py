"""组合管理路由 — 对齐 docs/ARCHITECTURE.md §4.2.2。

所有路由经 get_portfolio 依赖做归属隔离；/data 清空保留组合本身。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.services.auth import CurrentUser, get_current_user
from app.db.database import AsyncSessionLocal, get_db
from app.models import Portfolio, SecurityPrice
from app.common import get_portfolio
from app.serializers import serialize_portfolio, serialize_preference
from app.schemas import PortfolioArchiveReq, PortfolioCreateReq, PortfolioPatchReq
from app.schemas_resp import ClearDataOut, PortfolioOut, PreferenceOut
from app.services.market_data_sync import MarketDataSyncService
from app.services.portfolio import PortfolioService

router = APIRouter(prefix="/api", tags=["portfolios"], route_class=EnvelopeRoute)


@router.get("/portfolios", response_model=list[PortfolioOut])
async def list_portfolios(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list:
    rows = await PortfolioService(db).list_for_user(user.user_id)
    return [serialize_portfolio(p) for p in rows]


@router.post("/portfolios", response_model=PortfolioOut)
async def create_portfolio(
    req: PortfolioCreateReq,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    p = await PortfolioService(db).create(user.user_id, req)
    return serialize_portfolio(p)


@router.get("/portfolios/{portfolio_id}", response_model=PortfolioOut)
async def get_portfolio_detail(p: Portfolio = Depends(get_portfolio)) -> dict:
    return serialize_portfolio(p)


@router.patch("/portfolios/{portfolio_id}", response_model=PortfolioOut)
async def patch_portfolio(
    req: PortfolioPatchReq,
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    p = await PortfolioService(db).patch(p, req)
    return serialize_portfolio(p)


@router.delete("/portfolios/{portfolio_id}")
async def delete_portfolio(
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> None:
    await PortfolioService(db).delete(p)
    return None


@router.delete("/portfolios/{portfolio_id}/data", response_model=ClearDataOut)
async def clear_data(
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """清空组合所有数据（保留组合本身）。级联删除子表。"""
    counts = await PortfolioService(db).clear_data(p)
    return {"deletedCount": counts}


# --------------------------------------------------------------------------- #
# 实时行情同步（ADR-002 §2.6 三路端点）
# --------------------------------------------------------------------------- #
@router.post("/portfolios/{portfolio_id}/prices/sync")
async def sync_portfolio_prices_endpoint(
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """同步完整 fallback 链（路径 C）：同步等待，Σtimeout 封顶。

    返回结构化结果 ``{synced, failed, skipped, errors}``。
    """
    result = await MarketDataSyncService(db).sync_portfolio_prices(p.id)
    await db.commit()
    return result


@router.post("/portfolios/{portfolio_id}/prices/refresh-async", status_code=202)
async def refresh_async_portfolio_prices(
    p: Portfolio = Depends(get_portfolio),
) -> dict:
    """后台异步刷新（路径 B，fire-and-forget）：立即 202，不阻塞 UI。

    用独立会话跑完整链，避免请求会话关闭后后台任务访问已关闭会话。
    """
    portfolio_id = p.id

    async def _bg() -> None:
        async with AsyncSessionLocal() as s:
            try:
                await MarketDataSyncService(s).sync_portfolio_prices(portfolio_id)
                await s.commit()
            except Exception:
                await s.rollback()

    asyncio.create_task(_bg())
    return {"accepted": True, "portfolio_id": portfolio_id}


@router.get("/portfolios/{portfolio_id}/prices/sync-status")
async def sync_status_portfolio_prices(
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """刷新进度 / 最新 fetched_at 与来源（路径 B 收尾轮询）。"""
    row = (
        await db.execute(
            select(SecurityPrice.fetched_at, SecurityPrice.source)
            .where(SecurityPrice.portfolio_id == p.id)
            .order_by(SecurityPrice.fetched_at.desc())
            .limit(1)
        )
    ).first()
    return {
        "last_fetched_at": row[0].isoformat() if row and row[0] else None,
        "source": row[1] if row else None,
    }


@router.patch("/portfolios/{portfolio_id}/archive", response_model=PortfolioOut)
async def archive_portfolio(
    req: PortfolioArchiveReq,
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """归档 / 取消归档（§4.2.2）。

    archived 缺省或 true → archivedAt = now；false → 置空。
    归档时若该组合为用户偏好默认组合，则同步置空（被隐藏的组合不能再当默认）。
    """
    p = await PortfolioService(db).archive(p, req)
    return serialize_portfolio(p)


@router.patch("/portfolios/{portfolio_id}/default", response_model=PreferenceOut)
async def set_default_portfolio(
    p: Portfolio = Depends(get_portfolio),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """五角星设为默认 / 再次点击取消默认（toggle，需求项6）。"""
    pref = await PortfolioService(db).set_default(p, user.user_id)
    return serialize_preference(pref)
