"""提供方接口服务 — 证券行情数据提供方下的接口 CRUD + 顶层汇总。

与 QuoteProviderService 保持一致的风格：
- list_by_provider / list_all / get / create / update / delete。
- create/update 用关键字参 + Optional 局部更新（None 表示「未提供」）。
- provider 是否存在由路由层在 create 前校验（不存在 → 404）。

list_all() 供「按分类汇总所有提供方接口」总览：
- 后端扁平返回当前管理员可见的全部接口（复用 require_admin + EnvelopeRoute + 信封），
- 与现有 GET /api/admin/quote-providers/{provider_id}/interfaces 路径不冲突。
"""
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func, nullslast, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quote_interface import QuoteInterface
from app.services.interface_category import InterfaceCategoryService
from app.services.response_fields import (
    check_slot_contract,
    derive_legacy_columns,
    fold_legacy_columns,
    validate_response_fields,
)

# 允许被显式置 NULL（清空）的列：由模型可空性派生。
# 目的是让「清空资产类别」等置空操作生效，同时避免把 NOT NULL 列写成 NULL
# 触发 IntegrityError（如 name / resp_code_field / resp_price_field）。
_NULLABLE_COLUMNS = frozenset(
    col.key for col in QuoteInterface.__table__.columns if col.nullable
)

# line_regex 防护（P3）：长度上限 + 保存时预编译（非法正则直接 400）。
# 运行期在 market_data_sync 侧另有线程池隔离与文本长度钳制兜底。
_LINE_REGEX_MAX_LEN = 256

# 旧 4 列：（Expand 阶段双写镜像；请求只给旧列时折成 response_fields）
_LEGACY_FIELD_KEYS = (
    "resp_code_field",
    "resp_price_field",
    "resp_name_field",
    "resp_exchange_field",
)


def _raise_if_invalid(errors: list[str], prefix: str) -> None:
    """把纯校验返回的错误列表翻译为 400（风格对齐 _validate_response_parse）。"""
    if errors:
        raise HTTPException(
            status_code=400, detail=f"{prefix}：" + "；".join(errors)
        )


def _merge_date_mirror(
    response_parse: Optional[dict[str, Any]], mirror: dict[str, str]
) -> Optional[dict[str, Any]]:
    """把 response_fields 派生的 resp_date_field 合并进 response_parse（双写镜像）。"""
    if "resp_date_field" not in mirror:
        return response_parse
    merged = dict(response_parse or {})
    merged["resp_date_field"] = mirror["resp_date_field"]
    return merged


def _resolve_create_fields(
    *,
    response_fields: Optional[list[dict[str, Any]]],
    category_id: Optional[str],
    resp_code_field: Optional[str],
    resp_price_field: Optional[str],
    resp_name_field: Optional[str],
    resp_exchange_field: Optional[str],
    response_parse: Optional[dict[str, Any]],
) -> tuple[Optional[list[dict[str, Any]]], dict[str, str], Optional[dict[str, Any]]]:
    """create 时的字段落地计算，返回 (response_fields, 旧列镜像, response_parse)。

    - ``response_fields`` 显式非空 → 以其为准（静态 + 契约校验，违反 400），并派生旧列镜像；
    - 否则若请求给了旧列 → 确定性折成 ``response_fields``（老前端兼容）；
    - 两者都无 → ``response_fields`` 为 None（读侧走旧列合成）。
    """
    if response_fields:  # 显式非空（[] 视为未提供，走旧列分支）
        _raise_if_invalid(validate_response_fields(response_fields), "response_fields 校验失败")
        _raise_if_invalid(check_slot_contract(response_fields, category_id), "response_fields 契约不符")
        mirror = derive_legacy_columns(response_fields)
        return response_fields, mirror, _merge_date_mirror(response_parse, mirror)
    if any(v for v in (resp_code_field, resp_price_field, resp_name_field, resp_exchange_field)) or (
        response_parse or {}
    ).get("resp_date_field"):
        folded = fold_legacy_columns(
            category_id=category_id,
            resp_code_field=resp_code_field,
            resp_price_field=resp_price_field,
            resp_name_field=resp_name_field,
            resp_exchange_field=resp_exchange_field,
            response_parse=response_parse,
        )
        return (folded or None), {}, response_parse
    return None, {}, response_parse


def _validate_response_parse(rp: Optional[dict[str, Any]]) -> None:
    """校验 response_parse.line_regex：超长/非法正则 → 400，防 ReDoS 配置入库。"""
    if not rp:
        return
    pattern = rp.get("line_regex")
    if not pattern:
        return
    if len(pattern) > _LINE_REGEX_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"line_regex 过长（>{_LINE_REGEX_MAX_LEN} 字符），疑似非法配置",
        )
    try:
        re.compile(pattern)
    except re.error as exc:
        raise HTTPException(
            status_code=400, detail=f"line_regex 非法正则：{exc}"
        ) from exc


class QuoteInterfaceService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_provider(self, provider_id: str) -> list[QuoteInterface]:
        """列出某提供方全部接口，按 category_id + name 排序。"""
        result = await self.session.execute(
            select(QuoteInterface)
            .where(QuoteInterface.provider_id == provider_id)
            .order_by(QuoteInterface.category_id, QuoteInterface.name)
        )
        return list(result.scalars().all())

    async def list_all(self) -> list[QuoteInterface]:
        """列出全部接口（扁平，供顶层按分类汇总总览）。

        排序：分类优先，分类内按 priority 升序（NULL 沉底），最后以 name 兜底。
        必须按 priority 排序，否则拖拽调序写入后重拉仍按 name 弹回，视觉无变化
        （ADR-002 §5.3 拖拽调序链路的读路径）。
        """
        result = await self.session.execute(
            select(QuoteInterface).order_by(
                QuoteInterface.category_id,
                nullslast(QuoteInterface.priority),
                QuoteInterface.name,
            )
        )
        return list(result.scalars().all())

    async def get(self, interface_id: str) -> Optional[QuoteInterface]:
        return await self.session.get(QuoteInterface, interface_id)

    async def _next_priority(self, category_id: Optional[str]) -> Optional[int]:
        """计算某分类下新接口的落位优先级：COALESCE(MAX(priority), -1) + 1。

        未分类（category_id=None）返回 None（留 NULL）；分类内无接口时返回 0。
        """
        if category_id is None:
            return None
        row = (
            await self.session.execute(
                select(func.max(QuoteInterface.priority)).where(
                    QuoteInterface.category_id == category_id
                )
            )
        ).scalar()
        base = -1 if row is None else row
        return base + 1

    async def reorder(self, category_id: str, ordered_ids: list[str]) -> None:
        """同分类内按传入的完整有序 id 列表重排 priority = index。

        校验：ordered_ids 中每个 id 都必须属于同一个 category_id，否则抛 400
        （不允许把接口挪到别的分类链，也不允许混入不存在的 id）。
        要求前端传入该分类完整接口 id 列表（含未启用），避免悬挂优先级歧义。
        """
        if not ordered_ids:
            return
        result = await self.session.execute(
            select(QuoteInterface.id, QuoteInterface.category_id).where(
                QuoteInterface.id.in_(ordered_ids)
            )
        )
        rows = result.all()
        found_ids = {r[0] for r in rows}
        # 任一 id 不存在 → 视为非法请求
        if set(ordered_ids) - found_ids:
            raise HTTPException(status_code=400, detail="存在不存在的接口 id")
        # 任一 id 不属于该分类 → 跨分类混入，拒绝
        for r in rows:
            if r[1] != category_id:
                raise HTTPException(
                    status_code=400, detail="存在不属于该分类的接口 id"
                )
        # 事务内批量重排：priority = 数组下标
        for idx, qid in enumerate(ordered_ids):
            await self.session.execute(
                update(QuoteInterface)
                .where(QuoteInterface.id == qid)
                .values(priority=idx)
            )
        await self.session.flush()

    async def create(
        self,
        *,
        provider_id: str,
        category_id: str,
        name: str,
        endpoint: Optional[str] = None,
        http_method: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
        enabled: bool = True,
        description: Optional[str] = None,
        direction: str = "in",
        timeout: Optional[int] = None,
        retry_count: Optional[int] = None,
        rate_limit: Optional[str] = None,
        asset_class: Optional[list[str]] = None,
        resp_code_field: Optional[str] = None,
        resp_price_field: Optional[str] = None,
        resp_name_field: Optional[str] = None,
        resp_exchange_field: Optional[str] = None,
        response_parse: Optional[dict[str, Any]] = None,
        response_fields: Optional[list[dict[str, Any]]] = None,
    ) -> QuoteInterface:
        # 写入前显式校验 category_id 指向真实存在的分类：
        # 不依赖 DB 外键报错翻译（那样会落到 500 兜底），这里主动映射成 4xx。
        category = await InterfaceCategoryService(self.session).get_or_none(category_id)
        if category is None:
            raise HTTPException(status_code=400, detail="分类不存在")
        _validate_response_parse(response_parse)
        # 字段配置落地：response_fields 优先；仅给旧列时确定性折成 response_fields（Expand 双写）。
        rf_value, mirror, rp_value = _resolve_create_fields(
            response_fields=response_fields,
            category_id=category_id,
            resp_code_field=resp_code_field,
            resp_price_field=resp_price_field,
            resp_name_field=resp_name_field,
            resp_exchange_field=resp_exchange_field,
            response_parse=response_parse,
        )
        _validate_response_parse(rp_value)
        # 默认优先级：落该分类末位（COALESCE(MAX(priority),-1)+1）；未分类留 NULL。
        priority = await self._next_priority(category_id)
        obj = QuoteInterface(
            provider_id=provider_id,
            category_id=category_id,
            name=name,
            endpoint=endpoint,
            http_method=http_method,
            params=params if params is not None else {},
            enabled=enabled,
            description=description,
            direction=direction,
            timeout=timeout,
            retry_count=retry_count,
            rate_limit=rate_limit,
            priority=priority,
            asset_class=asset_class,
            resp_code_field=mirror.get("resp_code_field", resp_code_field),
            resp_price_field=mirror.get("resp_price_field", resp_price_field),
            resp_name_field=mirror.get("resp_name_field", resp_name_field),
            resp_exchange_field=mirror.get("resp_exchange_field", resp_exchange_field),
            response_parse=rp_value if rp_value is not None else {},
            response_fields=rf_value,
        )
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(
        self, obj: QuoteInterface, **opts: Any
    ) -> QuoteInterface:
        """局部更新：仅应用调用方显式提供的字段。

        调用方须传入 Pydantic 的 model_dump(exclude_unset=True) 结果，以便区分
        「客户端显式传 null（=清空）」与「未传该字段（=不改动）」——旧实现把两者
        都当 None 并一律跳过，导致资产类别取消全选后无法保存。

        可空列允许被显式置 NULL（清空生效）；非可空列遇到显式 None 仍跳过，
        避免写入 NULL 触发 IntegrityError。provider_id 不在更新范围内（接口归属不可改）。
        """
        # 若本次要写入新的 category_id（不为空），先校验其指向真实存在的分类。
        # 设为未分类（category_id=None）是允许的，无需校验。
        new_category_id = opts.get("category_id")
        if new_category_id is not None:
            category = await InterfaceCategoryService(self.session).get_or_none(new_category_id)
            if category is None:
                raise HTTPException(status_code=400, detail="分类不存在")
        if "response_parse" in opts:
            _validate_response_parse(opts["response_parse"])
        # —— response_fields / 旧列双写（Expand 阶段）——
        rf_explicit = "response_fields" in opts
        legacy_cols_explicit = any(k in opts for k in _LEGACY_FIELD_KEYS)
        target_category = opts.get("category_id", obj.category_id)
        if rf_explicit and opts["response_fields"]:
            fields = opts["response_fields"]
            _raise_if_invalid(
                validate_response_fields(fields), "response_fields 校验失败"
            )
            _raise_if_invalid(
                check_slot_contract(fields, target_category), "response_fields 契约不符"
            )
            # 新真相优先：由其派生旧列镜像（双写；供 P1 回滚）。
            mirror = derive_legacy_columns(fields)
            for column, source in mirror.items():
                if column != "resp_date_field":
                    opts[column] = source
            if "resp_date_field" in mirror:
                opts["response_parse"] = _merge_date_mirror(
                    opts.get("response_parse", obj.response_parse), mirror
                )
        elif legacy_cols_explicit or (
            "response_parse" in opts and not obj.response_fields
        ):
            # 老前端只给旧列（或历史行仅改 response_parse.resp_date_field）：
            # 确定性折成 response_fields 落库（旧列本身即镜像，不反向覆盖）。
            folded = fold_legacy_columns(
                category_id=target_category,
                resp_code_field=opts.get("resp_code_field", obj.resp_code_field),
                resp_price_field=opts.get("resp_price_field", obj.resp_price_field),
                resp_name_field=opts.get("resp_name_field", obj.resp_name_field),
                resp_exchange_field=opts.get("resp_exchange_field", obj.resp_exchange_field),
                response_parse=opts.get("response_parse", obj.response_parse),
            )
            if folded:
                opts["response_fields"] = folded
        elif "category_id" in opts and opts["category_id"] != obj.category_id:
            # 换同步用途：按新用途契约重校验既有 response_fields（方案边界 10）。
            if obj.response_fields:
                _raise_if_invalid(
                    check_slot_contract(obj.response_fields, opts["category_id"]),
                    "response_fields 契约不符",
                )
        if "response_parse" in opts:
            _validate_response_parse(opts["response_parse"])
        for key, value in opts.items():
            # 非 None 直接写入；None 仅在该列可空时写入（即「清空」语义）
            if value is not None or key in _NULLABLE_COLUMNS:
                setattr(obj, key, value)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def delete(self, obj: QuoteInterface) -> None:
        await self.session.delete(obj)
        await self.session.flush()
