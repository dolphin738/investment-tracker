"""管理员路由 —— 证券主数据浏览/统计/删除/同步 + 字段 schema + 接口试调与预览。

自 router.py 按职责拆出（架构治理 §4），覆盖原 ``router_admin`` 的**后 7 个**端点，
内部顺序与原文一致：

- 证券主数据目录：``GET /securities/masters``（分页+筛选，任意登录用户可读）、
  ``GET /securities/masters/stats``、``DELETE /securities/masters``（仅删孤儿）、
  ``POST /securities/sync``（需 admin）；
- 响应字段契约：``GET /quote-interfaces/response-field-schema``；
- 单接口试调：``POST /quote-interfaces/{interface_id}/test``；
- 新增态实调预览：``POST /quote-interfaces/preview``。

``_apply_master_filters`` 为列表与删除共用的筛选逻辑。

⚠️ 子 Router 自带 ``prefix`` 与 ``route_class``（``include_router`` 不继承父的 route_class）。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import paginate
from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.models import PortfolioSecurity, Security
from app.models.enums import QuoteProviderAccessMethod
from app.models.quote_provider import SecuritiesDataProvider
from app.modules.admin.schemas import (
    InterfacePreviewRequest,
    InterfaceTestRequest,
    SecurityMasterDeleteBody,
)
from app.serializers import serialize_security_master
from app.services.auth import CurrentUser, get_current_user, require_admin
from app.services.interface_preview import preview_https_interface, preview_sdk_interface
from app.services.market_data_sync import MarketDataSyncService
from app.services.response_fields import build_field_schema

router_master = APIRouter(prefix="/api/admin", tags=["admin"], route_class=EnvelopeRoute)


def _apply_master_filters(stmt, q, asset_class, exchange):
    """证券主数据列表/删除共用的筛选逻辑（q/asset_class/exchange）。"""
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Security.code.ilike(like),
                Security.name.ilike(like),
                Security.pinyin_initials.ilike(like),
            )
        )
    if asset_class:
        if asset_class == "UNCATEGORIZED":
            stmt = stmt.where(
                or_(Security.asset_class.is_(None), Security.asset_class == "UNCATEGORIZED")
            )
        else:
            stmt = stmt.where(Security.asset_class == asset_class)
    if exchange:
        ex = exchange.strip().upper()
        if ex in ("SH", "SZ", "BJ", "HK"):
            stmt = stmt.where(Security.exchange == ex)
    return stmt


@router_master.get("/securities/masters")
async def list_security_masters(
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    q: Optional[str] = Query(None, description="匹配 code/name/拼音首字母（ILIKE）"),
    asset_class: Optional[str] = Query(
        None,
        description="按资产类别过滤（SecurityType 值；UNCATEGORIZED=未分类，兼容主数据行 asset_class 为 NULL）",
    ),
    exchange: Optional[str] = Query(
        None,
        description="按交易所过滤（SH/SZ/BJ/HK；主数据行 exchange 可空，传入空字符串不做过滤）",
    ),
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """系统级证券主数据目录表分页浏览；q 匹配 code/name/拼音首字母。

    任意登录用户可读（§10：录入界面证券搜索复用本端点，主数据行是系统级公共字典）；
    写入（sync）与接口测试仍仅限管理员。
    """
    stmt = select(Security)
    stmt = _apply_master_filters(stmt, q, asset_class, exchange)
    # 全部分类视图下，按类别排序使「股票」置顶、「未分类」垫底，
    # 单类别筛选时整列类别一致，退化为 code 稳定排序，不影响筛选结果。
    category_rank = case(
        (Security.asset_class == "STOCK", 0),
        (Security.asset_class == "HK_STOCK", 1),
        (Security.asset_class.is_(None), 9),
        (Security.asset_class == "UNCATEGORIZED", 9),
        else_=3,
    )
    # 交易所排序：同类别内 沪(SH) < 深(SZ) < 京(BJ) < 港(HK) < 其他 < 无
    # 使股票分类下沪市先于深市、深市先于京市（替代原先按 code 字符串排序，
    # 原 'bj' < 'sh' 会让北交所误排沪市之前）。
    exchange_rank = case(
        (Security.exchange == "SH", 0),
        (Security.exchange == "SZ", 1),
        (Security.exchange == "BJ", 2),
        (Security.exchange == "HK", 3),
        (Security.exchange.is_(None), 5),
        else_=4,
    )
    stmt = stmt.order_by(category_rank.asc(), exchange_rank.asc(), Security.code.asc())
    return await paginate(db, stmt, page, pageSize, serialize_security_master)


@router_master.get("/securities/masters/stats")
async def security_master_stats(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """系统级证券主数据按资产类别统计条数（仅管理员可读，与 StockListPanel 管理页配套）。

    返回 ``{counts: {资产类别: 条数}}``；主数据行 asset_class 为 NULL 时归入
    ``UNCATEGORIZED``（未分类）以便前端与统一中文标签对齐。
    """
    rows = (
        await db.execute(
            select(Security.asset_class, func.count())
            .group_by(Security.asset_class)
        )
    ).all()
    counts: dict[str, int] = {}
    for ac, cnt in rows:
        key = ac.value if ac is not None else "UNCATEGORIZED"
        counts[key] = cnt
    return {"counts": counts}


@router_master.delete("/securities/masters")
async def delete_security_masters(
    body: SecurityMasterDeleteBody,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """批量/单行删除证券主数据（系统级目录表）。

    删除权限等同 ``POST /securities/sync``（``require_admin``）：非管理员 → 403，未登录 → 401。

    单事务（结尾仅一处 ``await db.commit()``）：先剔除「不存在」与「被组合持仓引用」的 id
    （计入 skipped），仅删除孤儿主数据，绝不波及用户数据——组合持仓/交易/价格/分红经
    ``FK ondelete=CASCADE`` 仅在删除「被引用」行时才级联，而本端点只删 **无任何
    portfolio_securities 引用** 的孤儿，DB 级联对孤儿无可删子行。

    - 默认（``all=False``）：按请求体传入的 ``ids`` 删除（去重后逐个校验）。
    - ``all=True``：删除「当前筛选条件下全部孤儿主数据」（跨所有页），忽略 ``ids``；
      ``q/asset_class/exchange`` 与列表端点一致，用于定位目标集合。该模式下候选 id 全部
      来自数据库，天然存在，``skipped`` 仅含被组合持仓引用的 id。

    返回 ``{deleted, skipped}``；skipped 每项 ``{id, reason}``。
    """
    # all 模式：按当前筛选条件拉取全部匹配 id，忽略 ids
    if body.all:
        match_stmt = _apply_master_filters(
            select(Security.id), body.q, body.asset_class, body.exchange
        )
        matched = (await db.execute(match_stmt)).scalars().all()
        candidate_ids = list(dict.fromkeys(matched))
    else:
        if not body.ids:
            raise HTTPException(status_code=400, detail="ids 不能为空或格式非法")
        candidate_ids = list(dict.fromkeys(body.ids))

    skipped: list[dict[str, str]] = []

    # 1) 存在性校验（all 模式下天然全存在，不会进入 skipped）
    existing = (
        await db.execute(select(Security.id).where(Security.id.in_(candidate_ids)))
    ).scalars().all()
    existing_set = set(existing)
    for i in candidate_ids:
        if i not in existing_set:
            skipped.append({"id": i, "reason": "主数据不存在"})

    # 2) 引用校验：被组合持仓引用的主数据不删，避免级联清除用户数据
    referenced = (
        await db.execute(
            select(func.distinct(PortfolioSecurity.master_id)).where(
                PortfolioSecurity.master_id.in_(existing)
            )
        )
    ).scalars().all()
    referenced_set = set(referenced)
    for i in candidate_ids:
        if i in referenced_set:
            skipped.append(
                {
                    "id": i,
                    "reason": "已被组合持仓引用，删除将级联清除用户数据，已跳过",
                }
            )

    # 3) 仅删孤儿（存在且未被引用）
    deletable = [
        i for i in candidate_ids if i in existing_set and i not in referenced_set
    ]
    if deletable:
        await db.execute(delete(Security).where(Security.id.in_(deletable)))

    await db.commit()
    return {"deleted": len(deletable), "skipped": skipped}


@router_master.post("/securities/sync")
async def admin_sync_security_masters(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """手动触发配置驱动的证券主数据全量同步（遍历全部 MASTER_LIST 接口的资产类别）。"""
    result = await MarketDataSyncService(db).sync_all_security_masters()
    await db.commit()
    return result


@router_master.get("/quote-interfaces/response-field-schema")
async def get_response_field_schema(
    current: CurrentUser = Depends(require_admin),
) -> dict:
    """响应字段契约 schema（方案 §6 单源供给）：``{slots, types, units, contracts}``。

    前端「字段映射」页签的 slot 下拉、按分类必填提示全部由此渲染，新增 slot 只改后端一处。
    """
    return build_field_schema()


@router_master.post("/quote-interfaces/{interface_id}/test")
async def test_quote_interface(
    interface_id: str,
    body: InterfaceTestRequest,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """单接口测试：用调用方传入的 params 调用，原样回传 raw+fieldHits（不计入 consecutive_failures）。"""
    result = await MarketDataSyncService(db).test_single_interface(
        interface_id, body.params, body.codes
    )
    return result


@router_master.post("/quote-interfaces/preview")
async def preview_quote_interface(
    body: InterfacePreviewRequest,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """新增态实调预览：不依赖已存接口，按提供方接入方式实调一次回传 raw。

    纯预览：不写库、不计入 consecutive_failures；SDK 走 akshare 懒导入，
    HTTPS 走 provider.base_url 实调（缺配置 / SSRF 拦截 / 上游错误均转
    ok:false + 中文原因，不 500）。
    """
    provider = await db.get(SecuritiesDataProvider, body.provider_id)
    if provider is None:
        raise HTTPException(status_code=400, detail="提供方不存在，无法实调预览")
    access_method = provider.access_method
    if access_method == QuoteProviderAccessMethod.SDK.value:
        return await preview_sdk_interface(body.endpoint, body.params)
    if access_method == QuoteProviderAccessMethod.HTTPS.value:
        return await preview_https_interface(
            db,
            provider.id,
            body.endpoint,
            params=body.params,
            response_parse=body.response_parse,
            http_method=body.http_method,
            codes=body.codes,
        )
    raise HTTPException(
        status_code=400,
        detail=f"该提供方接入方式（{access_method}）不支持实调预览（仅支持 SDK / HTTPS）",
    )
