"""股息率排名 API 与配置端点（方案 §9，阶段 4）。

七个端点（全部走统一信封默认）：
- GET   /api/dividend-yield/rankings             分红记录公司股息率分页排名（B2 排序白名单）
- GET   /api/dividend-yield/top20                股息率前 20（A12 剔除 suspicious、A13 封顶 20）
- GET   /api/dividend-yield/{master_id}/dividends 单证券分红明细（按报告期，仅列有分红的期次）
- GET   /api/dividend-yield/{master_id}/curve     单证券过去一年每日股息率曲线（§9 逐点现算）
- GET   /api/dividend-yield/{master_id}/implied-price 反推价格（§9）
- GET   /api/dividend-yield/settings     登录读取全局配置（§9：阈值标色需要）
- PUT   /api/dividend-yield/settings     admin 更新全局配置（阈值 + 接口三重校验）

口径/计算全部复用纯函数（services/dividend_yield.py），不在此重写计算逻辑；
分页枚举 bounds 沿用既有模块（page>=1、pageSize 1~200）；模块内仅编排查询与序列化。
"""
from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy import case, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.models import (
    MarketSecurityDailyPrice,
    Security,
    SecurityDividend,
    SecurityDividendYield,
)
from app.models.enums import (
    DividendStatus,
    DividendYieldMode,
)
from app.services.auth import CurrentUser, get_current_user
from app.services.base import paged
from app.services.dividend_period import period_label, plan_label
from app.services.dividend_yield import (
    compute_yield,
    compute_yield_at,
    implied_price,
    to_cell,
)

from app.modules.dividend_yield.backfill_router import router_backfill
from app.modules.dividend_yield.settings_router import router_settings

router_dividend_yield = APIRouter(
    prefix="/api/dividend-yield", tags=["dividend-yield"], route_class=EnvelopeRoute
)

router_dividend_yield.include_router(router_settings)
router_dividend_yield.include_router(router_backfill)

logger = logging.getLogger(__name__)

# 排序白名单（§8.1 五列：股息率/每股分子/最新收盘价/连续年数/口径），均降序 + NULLS LAST
# （PG DESC 默认 NULLS FIRST，漏写会让 NULL 值行顶到首页）；稳定 tiebreaker 用 master_id
# （分页不重不漏）。口径列为固定序：TTM 优先于 LFY（非字典序）。
_SORT_ASCENDING = (SecurityDividendYield.master_id.asc(),)
_MODE_TTM_FIRST = case(
    (SecurityDividendYield.mode == DividendYieldMode.TTM, 0),
    else_=1,
)
_SORT_COLUMNS = {
    "dividend_yield": SecurityDividendYield.dividend_yield.desc().nulls_last(),
    "numerator_per_share": SecurityDividendYield.numerator_per_share.desc().nulls_last(),
    "latest_price": SecurityDividendYield.latest_price.desc().nulls_last(),
    "consecutive_years": SecurityDividendYield.consecutive_years.desc().nulls_last(),
    "mode": _MODE_TTM_FIRST.asc(),
}

# 连续分红榜排序（§8.3 榜二）：consecutive_years DESC, dividend_yield DESC, master_id ASC
_CONSECUTIVE_ORDER = (
    SecurityDividendYield.consecutive_years.desc().nulls_last(),
    SecurityDividendYield.dividend_yield.desc().nulls_last(),
    *_SORT_ASCENDING,
)

_EXCHANGE_VALUES = ("SH", "SZ", "BJ")


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
    exchange: Optional[str] = Query(None),
    mode: Optional[str] = Query(None),
    min_consecutive: Optional[int] = Query(None, ge=0),
    include_proposed: bool = Query(True),
    include_no_dividend: bool = Query(False),
    q: Optional[str] = Query(None, max_length=50),
):
    """股息率排名（§8.1/§9）。

    - NULL 股息率不进榜（§3.5）；B2 排序白名单 + ``NULLS LAST`` + master_id tiebreaker；
    - 过滤参数：``exchange``/``mode``/``min_consecutive``/``include_proposed``/``include_no_dividend``
      （默认**剔除近两年无分红**，§8.2 窗口 [cur-1, cur] 由 ``last_dividend_year`` 表达）；
    - ``q`` 关键字过滤：按证券代码 / 名称模糊匹配（大小写不敏感，前后端统一搜索口径）；
    - ``include_proposed=false`` 时剔除 PROPOSED 后分子随之改变，按 §8.1 以过滤后记录集
      现调 §2.5 纯函数计算「过滤态股息率」，行内以 ``filtered=True`` 标注（排序仍用快照列）。
    """
    q_kw = (q or "").strip() or None
    if sort not in _SORT_COLUMNS:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"不支持的排序字段: {sort}",
            status_code=400,
        )
    mode_value: Optional[DividendYieldMode] = None
    if mode is not None:
        try:
            mode_value = DividendYieldMode(mode)
        except ValueError:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message=f"不支持的口径: {mode}",
                status_code=400,
            ) from None
    if exchange is not None and exchange not in _EXCHANGE_VALUES:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"不支持的交易所: {exchange}",
            status_code=400,
        )

    cur_year = today_app_tz().year
    # §3.5 守卫：NULL 不进榜；PG numeric NaN 亦是「缺失」（IS NOT NULL 拦不住 NaN，
    # 2026-09-08 排查 600339 结论），一并排除。数值比较 `!= 'NaN'` 对 NULL 返回
    # NULL（falsy），NULL 行仍由 is_not(None) 挡住，两条件叠加不冲突。
    _NAN = Decimal("NaN")
    conds = [
        SecurityDividendYield.dividend_yield.is_not(None),
        SecurityDividendYield.dividend_yield != _NAN,
    ]
    if exchange is not None:
        conds.append(Security.exchange == exchange)
    if mode_value is not None:
        conds.append(SecurityDividendYield.mode == mode_value)
    if min_consecutive is not None:
        conds.append(SecurityDividendYield.consecutive_years >= min_consecutive)
    if not include_no_dividend:
        # §8.2：窗口 [cur-1, cur] 内无分红即剔除（last_dividend_year 为 NULL 亦剔除）
        conds.append(SecurityDividendYield.last_dividend_year.is_not(None))
        conds.append(SecurityDividendYield.last_dividend_year >= cur_year - 1)
    if q_kw is not None:
        # q 关键字：代码 / 名称模糊匹配（需 join Securities 主数据取 code/name）
        like = f"%{q_kw}%"
        conds.append(or_(Security.code.ilike(like), Security.name.ilike(like)))

    stmt = select(SecurityDividendYield)
    if exchange is not None or q_kw is not None:
        stmt = stmt.join(Security, Security.id == SecurityDividendYield.master_id)
    stmt = stmt.where(*conds).order_by(_SORT_COLUMNS[sort], *_SORT_ASCENDING)

    rows, total = await paged(db, stmt, page, pageSize)
    sec_map = await _fetch_sec_map(db, rows)

    filtered = not include_proposed
    payout_map: dict[str, list] = {}
    if filtered and rows:
        div_rows = (
            await db.execute(
                select(SecurityDividend).where(
                    SecurityDividend.master_id.in_([r.master_id for r in rows])
                )
            )
        ).scalars().all()
        for d in div_rows:
            payout_map.setdefault(d.master_id, []).append(d)

    items: list[dict[str, Any]] = []
    for r in rows:
        item = _serialize_rank(r, sec_map.get(r.master_id))
        if filtered:
            # 过滤态股息率（§8.1）：剔除 PROPOSED 后按过滤记录集现算（价格为缺失时得 None）
            cells = [to_cell(d) for d in payout_map.get(r.master_id, [])]
            visible = [c for c in cells if c.status != DividendStatus.PROPOSED]
            recomputed = compute_yield(visible, r.latest_price, cur_year)
            item["dividend_yield"] = recomputed.dividend_yield
            item["numerator_per_share"] = recomputed.numerator_per_share
            item["ref_div_ids"] = list(recomputed.ref_div_ids) or None
        item["filtered"] = filtered
        items.append(item)
    return {"items": items, "total": total, "page": page, "pageSize": pageSize}


@router_dividend_yield.get("/top20")
async def top20_dividend_yield(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Top20 + 连续分红榜（§8.3，不分页；条数上限 20，决策 A13）。

    - Top20 榜：剔除 ``suspicious``（A12）与**近两年无分红**（§8.3 窗口 [cur-1, cur]，
      避免僵尸记录污染榜单）；
    - 连续分红榜：``consecutive_years >= 2``，排序
      ``consecutive_years DESC, dividend_yield DESC, master_id ASC``（§8.3）。
    """
    cur_year = today_app_tz().year
    # §3.5 守卫：与 rank 一致，NaN 视为缺失一并排除（IS NOT NULL 拦不住 NaN）
    _NAN = Decimal("NaN")
    top_stmt = (
        select(SecurityDividendYield)
        .where(
            SecurityDividendYield.dividend_yield.is_not(None),
            SecurityDividendYield.dividend_yield != _NAN,
            SecurityDividendYield.suspicious.is_(False),
            SecurityDividendYield.last_dividend_year.is_not(None),
            SecurityDividendYield.last_dividend_year >= cur_year - 1,
        )
        .order_by(SecurityDividendYield.dividend_yield.desc().nulls_last(), *_SORT_ASCENDING)
        .limit(20)
    )
    consecutive_stmt = (
        select(SecurityDividendYield)
        .where(
            SecurityDividendYield.consecutive_years >= 2,
            # 连续榜同样展示股息率列：NaN 视为缺失一并排除（与 rank/top 口径一致）
            SecurityDividendYield.dividend_yield.is_not(None),
            SecurityDividendYield.dividend_yield != _NAN,
        )
        .order_by(*_CONSECUTIVE_ORDER)
        .limit(20)
    )
    top_rows = (await db.execute(top_stmt)).scalars().all()
    cons_rows = (await db.execute(consecutive_stmt)).scalars().all()

    top_ids = {r.master_id for r in top_rows}
    all_rows = list(top_rows) + [r for r in cons_rows if r.master_id not in top_ids]
    sec_map = await _fetch_sec_map(db, all_rows)
    return {
        "top": [_serialize_rank(r, sec_map.get(r.master_id)) for r in top_rows],
        "consecutive": [_serialize_rank(r, sec_map.get(r.master_id)) for r in cons_rows],
    }


@router_dividend_yield.get("/{master_id}/dividends")
async def list_security_dividends(
    master_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """单证券分红明细（按报告期，供详情面板展示）。

    只列**有分红**的期次（``cash_per_share > 0``），按报告期倒序：
    - ``periodLabel``：2025年报 / 2025半年报 / 2025三季报 / 2023特别分配（§5.1 命名）；
    - ``planLabel``：每股金额折算回源站口径「10派X元」。
    """
    rows = (
        await db.execute(
            select(SecurityDividend)
            .where(
                SecurityDividend.master_id == master_id,
                SecurityDividend.cash_per_share > 0,
            )
            .order_by(
                SecurityDividend.report_year.desc(),
                SecurityDividend.report_quarter.desc(),
                SecurityDividend.period_type.asc(),
            )
        )
    ).scalars().all()

    def _enum_value(v: Any) -> str:
        return str(getattr(v, "value", v))

    return {
        "masterId": master_id,
        "items": [
            {
                "reportYear": r.report_year,
                "reportQuarter": r.report_quarter,
                "periodType": _enum_value(r.period_type),
                "periodLabel": period_label(
                    r.report_year, r.report_quarter, r.period_type
                ),
                "planLabel": plan_label(r.cash_per_share),
                "cashPerShare": str(r.cash_per_share),
                "status": _enum_value(r.status),
                "exDividendDate": (
                    r.ex_dividend_date.isoformat() if r.ex_dividend_date else None
                ),
                "announcementDate": (
                    r.announcement_date.isoformat() if r.announcement_date else None
                ),
            }
            for r in rows
        ],
    }


@router_dividend_yield.get("/{master_id}/curve")
async def curve_dividend_yield(
    master_id: str = Path(...),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    days: int = Query(365, ge=1, le=3650),  # 上限 10 年（P2-3：防 days 无界拉全量日线）
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
    cells = [to_cell(r) for r in div_rows]

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
                "close": pr.close,  # §9：供前端叠加「分子不变段」等提示
                "numerator_per_share": res.numerator_per_share,  # §9：分子不变段提示
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
        # §9 对照项：当前价与当前股息率（与隐含价格/目标比率对照展示）
        "current_price": snapshot.latest_price if snapshot is not None else None,
        "current_dividend_yield": snapshot.dividend_yield if snapshot is not None else None,
    }
