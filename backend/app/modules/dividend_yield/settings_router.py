"""股息率全局配置端点（方案 §9，阶段 4；自 router.py 拆分而来）。

仅承载配置读写两类端点与配套 helper：
- GET  /api/dividend-yield/settings   登录读取全局配置（§9：阈值标色需要）
- PUT  /api/dividend-yield/settings   admin 更新全局配置（阈值 + 接口三重校验）

口径/计算复用 services 纯函数，本模块仅编排查询与校验；``load_settings``
作为跨模块公共 API 供 backfill_router 消费（见其文档串）。
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.date_utils import today_app_tz
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    SecuritiesDataProvider,
)
from app.models.enums import QuoteProviderAccessMethod
from app.services.auth import CurrentUser, get_current_user, require_admin
from app.services.log import record
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    QUOTE_CAT_ID,
    NOTICE_CAT_ID,
)

router_settings = APIRouter(route_class=EnvelopeRoute)


class SettingsUpdateBody(BaseModel):
    green_threshold: Decimal
    red_threshold: Decimal
    dividend_report_source_interface_id: Optional[str] = None
    dividend_detail_source_interface_id: Optional[str] = None
    price_source_interface_id: Optional[str] = None
    announcement_source_interface_id: Optional[str] = None
    price_backfill_source_interface_id: Optional[str] = None
    # 每日回补额度（只/天）：1..2000，越界 PUT 400。为 None 表示不改（保留既有值）。
    # 注意：price_backfill_start_date 不接受 PUT 设置（由触发/完成流程服务端管理，避免状态不一致）。
    price_backfill_quota: Optional[int] = None


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


def _is_per_symbol_interface(itf: QuoteInterface) -> bool:
    """调用形态判定（§5.4 第四重）：params 含 ``symbol`` 键 = 按证券逐只形态。

    seed 数据实证：主源「东财-分红配送」params={"date": ...}（无 symbol，按报告期全量）；
    补充源「新浪-分红配股」params={"symbol": ...}（逐只）。
    """
    return bool(itf.params) and "symbol" in itf.params


async def _validate_interface(
    db: AsyncSession,
    interface_id: Optional[str],
    category_id: str,
    *,
    require_per_symbol: bool,
) -> None:
    """接口四重校验（§5.4）：存在性 + 分类归属 + enabled + **调用形态**；缺省（null/省略）允许置空。

    形态不符须拒绝——把逐只接口当主源会让 §6.1 按报告期抓取静默失效。
    """
    if not interface_id:
        return
    itf = await db.get(QuoteInterface, interface_id)
    if itf is None or itf.category_id != category_id or not itf.enabled:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="接口不存在、分类不符或未启用",
            status_code=400,
        )
    if _is_per_symbol_interface(itf) != require_per_symbol:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=(
                "接口调用形态不符：主源/行情源须为按报告期全量接口（params 无 symbol），"
                "补充源须为按证券逐只接口（params 含 symbol）"
            ),
            status_code=400,
        )


async def _validate_backfill_interface(db: AsyncSession, interface_id: Optional[str]) -> None:
    """历史行情回补源校验：存在性 + 分类 2 + enabled + **接入方式 sdk**；缺省允许置空。

    **不做**「params 是否含 symbol」的形态启发式——``stock_zh_a_hist`` 天然逐只入参
    （params 必含 symbol 占位，实库 ``东财-历史行情`` 即如此），该启发式是为股息列表
    分类（报告期全量 vs 按证券逐只）设计的，对回补源不适用；路线 B 的硬约束是
    ``backfill_historical`` 要求 sdk 接入（与 ``/backfill-prices`` 运行时校验同口径）。
    """
    if not interface_id:
        return
    itf = await db.get(QuoteInterface, interface_id)
    if itf is None or itf.category_id != QUOTE_CAT_ID or not itf.enabled:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="接口不存在、分类不符或未启用",
            status_code=400,
        )
    provider = await db.get(SecuritiesDataProvider, itf.provider_id)
    if provider is None or provider.access_method != QuoteProviderAccessMethod.SDK:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=(
                "历史行情回补接口接入方式须为 sdk（akshare stock_zh_a_hist），"
                f"当前接口 {itf.name!r} 的提供方接入方式为 "
                f"{provider.access_method if provider else '未知'}"
            ),
            status_code=400,
        )


async def load_settings(db: AsyncSession) -> DividendYieldSettings:
    """读取单行配置；无行时返回空默认（阈值 0.05/0.03、三接口 null）。

    跨模块复用即公共 API（被 backfill_router 消费）。
    """
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
        "announcement_source": _interface_out(
            await _resolve_interface(db, row.announcement_source_interface_id)
        ),
        "price_backfill_source": _interface_out(
            await _resolve_interface(db, row.price_backfill_source_interface_id)
        ),
        # 每日回补额度（只/天）；在途回补起点日期——非空即表示存在在途回补任务
        "price_backfill_quota": row.price_backfill_quota,
        "price_backfill_start_date": (
            row.price_backfill_start_date.isoformat()
            if row.price_backfill_start_date is not None
            else None
        ),
        # 当日已用额度：前端据此展示「今日已用 X/N」并在用尽时禁用触发按钮。
        # 这里回传**当日有效值**（记账日不是今天则视为 0），避免前端重复实现跨日重置。
        "price_backfill_used_today": (
            row.price_backfill_used_today
            if row.price_backfill_last_run_date == today_app_tz()
            else 0
        ),
    }


@router_settings.get("/settings")
async def get_dividend_yield_settings(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取全局配置（登录即可读，§9：仅 PUT 收 admin——非 admin 拿到阈值才能标色）。"""
    row = await load_settings(db)
    return await _settings_out(db, row)


@router_settings.put("/settings")
async def put_dividend_yield_settings(
    body: SettingsUpdateBody,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """更新全局配置（§5.4/§6.6：非 admin 403；阈值 0<red<green<=1；接口四重校验 400 不落库；AppLog 审计）。"""
    green, red = body.green_threshold, body.red_threshold
    if not (Decimal("0") < red < green <= Decimal("1")):
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="阈值须满足 0 < red_threshold < green_threshold <= 1",
            status_code=400,
        )
    await _validate_interface(
        db, body.dividend_report_source_interface_id, DIVIDEND_LIST_CAT_ID, require_per_symbol=False
    )
    await _validate_interface(
        db, body.dividend_detail_source_interface_id, DIVIDEND_LIST_CAT_ID, require_per_symbol=True
    )
    await _validate_interface(
        db, body.price_source_interface_id, QUOTE_CAT_ID, require_per_symbol=False
    )
    # 公告源：分类 4「公司公告」；stock_notice_report 接口 params 含 symbol → 逐只形态
    await _validate_interface(
        db, body.announcement_source_interface_id, NOTICE_CAT_ID, require_per_symbol=True
    )
    # 历史行情回补源：分类 2「证券行情」+ 接入方式 sdk（路线 B）；
    # 不做 symbol 形态启发式（stock_zh_a_hist 天然逐只带 symbol，见 helper 文档串）
    await _validate_backfill_interface(db, body.price_backfill_source_interface_id)

    # 每日回补额度（只/天）：1..2000；为 None 表示不改（保留既有值）。越界 400 中文。
    if body.price_backfill_quota is not None and not (1 <= body.price_backfill_quota <= 2000):
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="每日回补额度 price_backfill_quota 须为 1..2000（只/天）",
            status_code=400,
        )

    row = await load_settings(db)
    is_new = row.id is None  # 空默认（无持久化行）时插入，否则更新既有行
    before_detail = {
        "green_threshold": str(row.green_threshold),
        "red_threshold": str(row.red_threshold),
        "dividend_report_source_interface_id": row.dividend_report_source_interface_id,
        "dividend_detail_source_interface_id": row.dividend_detail_source_interface_id,
        "price_source_interface_id": row.price_source_interface_id,
        "announcement_source_interface_id": row.announcement_source_interface_id,
        "price_backfill_source_interface_id": row.price_backfill_source_interface_id,
        "price_backfill_quota": row.price_backfill_quota,
    }
    row.green_threshold = green
    row.red_threshold = red
    row.dividend_report_source_interface_id = body.dividend_report_source_interface_id
    row.dividend_detail_source_interface_id = body.dividend_detail_source_interface_id
    row.price_source_interface_id = body.price_source_interface_id
    row.announcement_source_interface_id = body.announcement_source_interface_id
    row.price_backfill_source_interface_id = body.price_backfill_source_interface_id
    # 仅当请求体显式给出额度时才覆盖（None = 不改）；before 已记录旧值供审计
    if body.price_backfill_quota is not None:
        row.price_backfill_quota = body.price_backfill_quota
    row.updated_by = admin.user_id
    if is_new:
        db.add(row)
    await db.commit()
    # §6.6 审计：配置变更写 AppLog（操作人 + 变更前后值）
    await record(
        level="info",
        scope="admin",
        module="dividend_yield_settings",
        message="股息率全局配置更新",
        detail={
            "before": before_detail,
            "after": {
                "green_threshold": str(green),
                "red_threshold": str(red),
                "dividend_report_source_interface_id": body.dividend_report_source_interface_id,
                "dividend_detail_source_interface_id": body.dividend_detail_source_interface_id,
                "price_source_interface_id": body.price_source_interface_id,
                "announcement_source_interface_id": body.announcement_source_interface_id,
                "price_backfill_source_interface_id": body.price_backfill_source_interface_id,
                "price_backfill_quota": row.price_backfill_quota,
            },
        },
        user_id=admin.user_id,
    )
    return await _settings_out(db, row)
