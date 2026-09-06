"""股息率排名 API 与配置端点（方案 §9，阶段 4）。

六个端点（全部走统一信封默认）：
- GET   /api/dividend-yield/rankings             分红记录公司股息率分页排名（B2 排序白名单）
- GET   /api/dividend-yield/top20                股息率前 20（A12 剔除 suspicious、A13 封顶 20）
- GET   /api/dividend-yield/{master_id}/curve     单证券过去一年每日股息率曲线（§9 逐点现算）
- GET   /api/dividend-yield/{master_id}/implied-price 反推价格（§9）
- GET   /api/dividend-yield/settings     admin 读取全局配置（§5.4）
- PUT   /api/dividend-yield/settings     admin 更新全局配置（阈值 + 接口三重校验）

口径/计算全部复用纯函数（services/dividend_yield.py），不在此重写计算逻辑；
分页枚举 bounds 沿用既有模块（page>=1、pageSize 1~200）；模块内仅编排查询与序列化。
"""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.models import (
    DividendYieldSettings,
    MarketSecurityDailyPrice,
    QuoteInterface,
    Security,
    SecurityDividend,
    SecurityDividendYield,
)
from app.services.auth import CurrentUser, get_current_user, require_admin
from app.services.base import paged
from app.services.dividend_sync import _to_cell
from app.services.dividend_yield import compute_yield_at, implied_price
from app.services.market_data_sync import DIVIDEND_LIST_CAT_ID, QUOTE_CAT_ID

router_dividend_yield = APIRouter(
    prefix="/api/dividend-yield", tags=["dividend-yield"], route_class=EnvelopeRoute
)

# 排序白名单（B2 §9）：仅允许两列，均按降序；稳定 tiebreaker 用 master_id
_SORT_ASCENDING = (SecurityDividendYield.master_id.asc(),)
_SORT_COLUMNS = {
    "dividend_yield": SecurityDividendYield.dividend_yield.desc(),
    "consecutive_years": SecurityDividendYield.consecutive_years.desc(),
}


def _sec(code: Optional[str], name: Optional[str], exchange: Optional[str]) -> dict[str, Any]:
    """证券主数据投影（缺失返回 None，不臆造兜底值）。"""
    return {"code": code, "name": name, "exchange": exchange}


async def _fetch_sec_map(
    db: AsyncSession, rows: list[SecurityDividendYield]
) -> dict[str, Security]:
    """按 master_id 批量取证券主数据，供序列化填充 code/name/exchange。"""
    mids = [r.master_id for r in rows]
    if not mids:
        return {}
    secs = (
        await db.execute(select(Security).where(Security.id.in_(mids)))
    ).scalars().all()
    return {s.id: s for s in secs}


def _serialize_rank(
    row: SecurityDividendYield, sec: Optional[Security]
) -> dict[str, Any]:
    """榜单行序列化（含证券 code/name/exchange）。"""
    return {
        "master_id": row.master_id,
        "code": sec.code if sec else None,
        "name": sec.name if sec else None,
        "exchange": sec.exchange if sec else None,
        "mode": row.mode.value,
        "dividend_yield": row.dividend_yield,
        "numerator_per_share": row.numerator_per_share,
        "latest_price": row.latest_price,
        "latest_trade_date": row.latest_trade_date,
        "consecutive_years": row.consecutive_years,
        "last_dividend_year": row.last_dividend_year,
        "stale": row.stale,
        "suspicious": row.suspicious,
        "computed_at": row.computed_at,
    }


@router_dividend_yield.get("/rankings")
async def rank_dividend_yield(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    sort: str = Query("dividend_yield"),
):
    """股息率排名（§3.5：NULL 股息率不进榜；§9 B2 排序白名单）。"""
    if sort not in _SORT_COLUMNS:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"不支持的排序字段: {sort}",
            status_code=400,
        )
    stmt = (
        select(SecurityDividendYield)
        .where(SecurityDividendYield.dividend_yield.is_not(None))
        .order_by(_SORT_COLUMNS[sort], *_SORT_ASCENDING)
    )
    rows, total = await paged(db, stmt, page, pageSize)
    sec_map = await _fetch_sec_map(db, rows)
    items = [_serialize_rank(r, sec_map.get(r.master_id)) for r in rows]
    return {"items": items, "total": total, "page": page, "pageSize": pageSize}


@router_dividend_yield.get("/top20")
async def top20_dividend_yield(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """股息率前 20（§8.3/A12 剔除 suspicious；A13 封顶 20 条，不分页）。"""
    stmt = (
        select(SecurityDividendYield)
        .where(
            SecurityDividendYield.dividend_yield.is_not(None),
            SecurityDividendYield.suspicious.is_(False),
        )
        .order_by(
            SecurityDividendYield.dividend_yield.desc(), *_SORT_ASCENDING
        )
        .limit(20)
    )
    rows = (await db.execute(stmt)).scalars().all()
    sec_map = await _fetch_sec_map(db, list(rows))
    items = [_serialize_rank(r, sec_map.get(r.master_id)) for r in rows]
    return {"items": items}


@router_dividend_yield.get("/{master_id}/curve")
async def curve_dividend_yield(
    master_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    days: int = Query(365, ge=1),
):
    """单证券每日股息率曲线（§9 逐点现算；末点 == 快照值由纯函数保证）。"""
    sec = await db.get(Security, master_id)
    yield_exists = (
        await db.execute(
            select(SecurityDividendYield.master_id).where(
                SecurityDividendYield.master_id == master_id
            )
        )
    ).scalar_one_or_none()
    if sec is None and yield_exists is None:
        raise BusinessException(
            code=BusinessErrorCode.NOT_FOUND,
            message="证券不存在",
            status_code=404,
        )

    div_rows = (
        await db.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == master_id)
        )
    ).scalars().all()
    cells = [_to_cell(r) for r in div_rows]

    start = today_app_tz() - timedelta(days=days)
    price_rows = (
        await db.execute(
            select(MarketSecurityDailyPrice)
            .where(
                MarketSecurityDailyPrice.master_id == master_id,
                MarketSecurityDailyPrice.trade_date >= start,
            )
            .order_by(MarketSecurityDailyPrice.trade_date.asc())
        )
    ).scalars().all()

    cur_year = today_app_tz().year
    items: list[dict[str, Any]] = []
    for pr in price_rows:
        res = compute_yield_at(cells, pr.trade_date, pr.close, cur_year)
        items.append(
            {
                "trade_date": pr.trade_date,
                "dividend_yield": res.dividend_yield,
                "mode": res.mode.value,
            }
        )
    return {
        "items": items,
        "master_id": master_id,
        "code": sec.code if sec else None,
        "name": sec.name if sec else None,
    }


@router_dividend_yield.get("/{master_id}/implied-price")
async def implied_price_endpoint(
    master_id: str = Path(...),
    target_ratio: float = Query(..., gt=0, le=1),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """反推价格（§9）：implied_price = 每股东分子 / target_ratio（小数比率）。"""
    snapshot = (
        await db.execute(
            select(SecurityDividendYield).where(
                SecurityDividendYield.master_id == master_id
            )
        )
    ).scalar_one_or_none()
    sec = await db.get(Security, master_id)

    numerator = snapshot.numerator_per_share if snapshot is not None else None
    ratio = Decimal(str(target_ratio))
    return {
        "master_id": master_id,
        "code": sec.code if sec else None,
        "name": sec.name if sec else None,
        "numerator_per_share": numerator,
        "target_ratio": ratio,
        "implied_price": implied_price(numerator, ratio),
    }


# --------------------------------------------------------------------------- #
# 配置端点（§5.4 / §6.6：阈值 + 接口三重校验，fail closed 400 不落库）
# --------------------------------------------------------------------------- #
class SettingsUpdateBody(BaseModel):
    green_threshold: Decimal
    red_threshold: Decimal
    dividend_report_source_interface_id: Optional[str] = None
    dividend_detail_source_interface_id: Optional[str] = None
    price_source_interface_id: Optional[str] = None


def _interface_out(itf: Optional[QuoteInterface]) -> Optional[dict[str, Any]]:
    """接口投影 {id, name}；未配置返回 None。"""
    if itf is None:
        return None
    return {"id": itf.id, "name": itf.name}


async def _resolve_interface(db: AsyncSession, interface_id: Optional[str]):
    """按 id 解析接口（读侧兜底，不作分类/enabled 强校验）。"""
    if not interface_id:
        return None
    return await db.get(QuoteInterface, interface_id)


async def _validate_interface(
    db: AsyncSession, interface_id: Optional[str], category_id: str
) -> None:
    """接口三重校验：存在性 + 分类归属 + enabled；缺省（null/省略）允许置空。"""
    if not interface_id:
        return
    itf = await db.get(QuoteInterface, interface_id)
    if itf is None or itf.category_id != category_id or not itf.enabled:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="接口不存在、分类不符或未启用",
            status_code=400,
        )


async def _load_settings(db: AsyncSession) -> DividendYieldSettings:
    """读取单行配置；无行时返回空默认（阈值 0.05/0.03、三接口 null）。"""
    row = (
        await db.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one_or_none()
    if row is None:
        return DividendYieldSettings(
            green_threshold=Decimal("0.05"),
            red_threshold=Decimal("0.03"),
        )
    return row


async def _settings_out(db: AsyncSession, row: DividendYieldSettings) -> dict[str, Any]:
    """配置序列化：阈值 + resolve 后的三个接口 {id, name}。"""
    return {
        "green_threshold": row.green_threshold,
        "red_threshold": row.red_threshold,
        "dividend_report_source": _interface_out(
            await _resolve_interface(db, row.dividend_report_source_interface_id)
        ),
        "dividend_detail_source": _interface_out(
            await _resolve_interface(db, row.dividend_detail_source_interface_id)
        ),
        "price_source": _interface_out(
            await _resolve_interface(db, row.price_source_interface_id)
        ),
    }


@router_dividend_yield.get("/settings")
async def get_dividend_yield_settings(
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """读取全局配置（admin-only）。"""
    row = await _load_settings(db)
    return await _settings_out(db, row)


@router_dividend_yield.put("/settings")
async def put_dividend_yield_settings(
    body: SettingsUpdateBody,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """更新全局配置（§5.4/§6.6：非 admin 403；阈值 0<red<green<=1；接口三重校验 400 不落库）。"""
    green, red = body.green_threshold, body.red_threshold
    if not (Decimal("0") < red < green <= Decimal("1")):
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="阈值须满足 0 < red_threshold < green_threshold <= 1",
            status_code=400,
        )
    await _validate_interface(db, body.dividend_report_source_interface_id, DIVIDEND_LIST_CAT_ID)
    await _validate_interface(db, body.dividend_detail_source_interface_id, DIVIDEND_LIST_CAT_ID)
    await _validate_interface(db, body.price_source_interface_id, QUOTE_CAT_ID)

    row = await _load_settings(db)
    is_new = row.id is None  # 空默认（无持久化行）时插入，否则更新既有行
    row.green_threshold = green
    row.red_threshold = red
    row.dividend_report_source_interface_id = body.dividend_report_source_interface_id
    row.dividend_detail_source_interface_id = body.dividend_detail_source_interface_id
    row.price_source_interface_id = body.price_source_interface_id
    row.updated_by = admin.user_id
    if is_new:
        db.add(row)
    await db.commit()
    return await _settings_out(db, row)