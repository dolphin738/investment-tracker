"""股息率全局配置端点（方案 §9，阶段 4；自 router.py 拆分而来）。

仅承载配置读写两类端点与配套 helper：
- GET  /api/dividend-yield/settings   登录读取全局配置（数据源接口；标色阈值已迁用户偏好）
- PUT  /api/dividend-yield/settings   admin 更新全局配置（接口三重校验）

口径/计算复用 services 纯函数，本模块仅编排查询与校验。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.models import (
    DividendYieldSettings,
    QuoteInterface,
)
from app.services.auth import CurrentUser, get_current_user, require_admin
from app.services.log import record
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    QUOTE_CAT_ID,
    NOTICE_CAT_ID,
)

router_settings = APIRouter(route_class=EnvelopeRoute)


class SettingsUpdateBody(BaseModel):
    # 注：股息率标色阈值已迁至「用户偏好」（user_preferences，见 0026 迁移）；
    # 本端点不再接受阈值字段（对应全局两列已由 0027 迁移删除）。
    # extra="forbid"：Pydantic 默认 extra='ignore' 会让陈旧客户端发来的 green_threshold 静默不生效
    # （返 200 却什么都没改），改为显式 400 —— 避免「以为改了其实没改」。
    model_config = ConfigDict(extra="forbid")

    dividend_detail_source_interface_id: Optional[str] = None
    price_source_interface_id: Optional[str] = None
    announcement_source_interface_id: Optional[str] = None
    # 交易日历刷新起始日期（YYYY-MM-DD）：refresh_trade_calendar 的窗口下限，决定
    # 「获取多长时间」（上限受数据源限制只到当年末，故不暴露）。None 表示不改。
    trade_calendar_start_date: Optional[date] = None


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


async def load_settings(db: AsyncSession) -> DividendYieldSettings:
    """读取单行配置；无行时返回空默认（各数据源接口 null；标色阈值已迁用户偏好，不在本表）。"""
    row = (
        await db.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one_or_none()
    if row is None:
        return DividendYieldSettings()
    return row


async def _settings_out(db: AsyncSession, row: DividendYieldSettings) -> dict[str, Any]:
    """配置序列化：resolve 后的数据源接口 {id, name}（阈值已迁用户偏好，不在此返回）。"""
    return {
        "dividend_detail_source": _interface_out(
            await _resolve_interface(db, row.dividend_detail_source_interface_id)
        ),
        "price_source": _interface_out(
            await _resolve_interface(db, row.price_source_interface_id)
        ),
        "announcement_source": _interface_out(
            await _resolve_interface(db, row.announcement_source_interface_id)
        ),
        # 交易日历刷新起始日期（可保存）：None = 未配置 → 后端用默认下限「去年 1 月 1 日」
        "trade_calendar_start_date": (
            row.trade_calendar_start_date.isoformat()
            if row.trade_calendar_start_date is not None
            else None
        ),
    }


@router_settings.get("/settings")
async def get_dividend_yield_settings(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取全局配置（登录即可读，§9：仅 PUT 收 admin；标色阈值已迁用户偏好，本端点不返回）。"""
    row = await load_settings(db)
    return await _settings_out(db, row)


@router_settings.put("/settings")
async def put_dividend_yield_settings(
    body: SettingsUpdateBody,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """更新全局配置（§5.4/§6.6：非 admin 403；接口四重校验 400 不落库；AppLog 审计）。"""
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

    row = await load_settings(db)
    is_new = row.id is None  # 空默认（无持久化行）时插入，否则更新既有行
    before_detail = {
        "dividend_detail_source_interface_id": row.dividend_detail_source_interface_id,
        "price_source_interface_id": row.price_source_interface_id,
        "announcement_source_interface_id": row.announcement_source_interface_id,
        "trade_calendar_start_date": (
            row.trade_calendar_start_date.isoformat()
            if row.trade_calendar_start_date is not None
            else None
        ),
    }
    row.dividend_detail_source_interface_id = body.dividend_detail_source_interface_id
    row.price_source_interface_id = body.price_source_interface_id
    row.announcement_source_interface_id = body.announcement_source_interface_id
    # 交易日历刷新起始日期：显式提交语义（显式 null = 清除 → 用默认下限）
    if "trade_calendar_start_date" in body.model_fields_set:
        row.trade_calendar_start_date = body.trade_calendar_start_date
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
                "dividend_detail_source_interface_id": body.dividend_detail_source_interface_id,
                "price_source_interface_id": body.price_source_interface_id,
                "announcement_source_interface_id": body.announcement_source_interface_id,
                "trade_calendar_start_date": (
                    row.trade_calendar_start_date.isoformat()
                    if row.trade_calendar_start_date is not None
                    else None
                ),
            },
        },
        user_id=admin.user_id,
    )
    return await _settings_out(db, row)
