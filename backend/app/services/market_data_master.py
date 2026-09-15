"""证券主数据同步 mixin（配置驱动，归属「证券列表」分类，§7 ① / §11）。

自 ``market_data_sync`` 按位置拆分而来（ADR-002 / 架构治理 §4）：承载
``sync_security_masters`` / ``sync_all_security_masters`` 编排与
``_prepare_master_rows``（纯 CPU 归一化）/ ``_upsert_masters``（批量落库）。

跨 mixin 协作（由门面 MRO 解析，调用点零改动）：

- ``self._active_provider_join`` / ``self._mark_success`` / ``self._mark_failure``
  / ``self._filter_required_rows`` → ``MarketDataPriceMixin``；
- ``self._call_interface_raw`` → ``MarketDataInterfaceMixin``；
- ``self._normalize_and_dedupe_masters`` → ``SecurityMasterHealMixin``。

依赖方向：``market_data_params ← 本模块``；本模块不得 import 门面（循环导入）。
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional

import pypinyin
from pypinyin import Style
from sqlalchemy import func, select, tuple_

from app.models.enums import SecurityType
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import Security
from app.services.classification import (
    EXCHANGE_PREFIX,
    classify_security,
    infer_exchange,
    is_dropped,
)
from app.services.market_data_params import (
    MASTER_LIST_CAT_ID,
    _normalize_master_code,
    master_id_for,
)
from app.services.response_fields import (
    SLOT_CODE,
    SLOT_EXCHANGE,
    SLOT_NAME,
    index_by_slot,
    resolve_fields,
)
from app.services.security import infer_security_type

logger = logging.getLogger(__name__)


def _compute_pinyin_initials(name: str) -> Optional[str]:
    """名称 → 拼音首字母（如 贵州茅台→gzm）；异常时返回 None 不阻断同步。"""
    if not name:
        return None
    try:
        initials = pypinyin.pinyin(name, style=Style.FIRST_LETTER, heteronym=False)
        return "".join(seg[0].lower() for seg in initials if seg)
    except Exception:
        return None


class SecurityMasterSyncMixin:
    """证券主数据同步（配置驱动选源 + 归一化 + 批量 upsert）。"""

    # ------------------------------------------------------------------ #
    # 证券主数据同步（配置驱动，归属「证券列表」分类，§7 ① / §11）
    # ------------------------------------------------------------------ #
    async def sync_security_masters(
        self,
        asset_class: Optional[str] = None,
        _fetch_cache: Optional[dict[str, Optional[list[Any]]]] = None,
    ) -> dict[str, Any]:
        """配置驱动同步某资产类别的证券主数据（归属「证券列表」分类的接口，priority 降级链）。

        仅选 ``portfolio_id IS NULL`` 的系统主数据行承载全市场列表；命中优先链即停。
        返回结构化结果 ``{synced, failed, errors}``。

        ``_fetch_cache``（内部参数）：按接口 id 缓存原始行，使服务多个 asset_class 的接口
        在 ``sync_all_security_masters`` 的多批次遍历中，同端点只请求一次（消除多选冗余调用）。
        """
        stmt = (
            select(QuoteInterface)
            .where(
                QuoteInterface.category_id == MASTER_LIST_CAT_ID,
                QuoteInterface.enabled == True,  # noqa: E712
            )
        )
        stmt = self._active_provider_join(stmt)
        if asset_class is not None:
            # asset_class 为多选数组：选中包含该类别的接口（ac = ANY(asset_class)）
            stmt = stmt.where(QuoteInterface.asset_class.any(asset_class))
        stmt = stmt.order_by(
            QuoteInterface.priority.is_(None),
            QuoteInterface.priority,
        )
        interfaces = list((await self.session.execute(stmt)).scalars().all())

        synced = 0
        failed = 0
        errors: list[str] = []
        used: Optional[dict[str, Any]] = None
        for itf in interfaces:
            # 多选优化：同一接口服务多个 asset_class 时，各批次都会把它当候选；
            # 用按接口 id 的缓存确保同端点整轮只请求一次（upsert 去重不变）。
            if _fetch_cache is not None and itf.id in _fetch_cache:
                rows = _fetch_cache[itf.id]
            else:
                try:
                    rows = await self._call_interface_raw(itf, itf.params, None)
                except Exception as exc:
                    rows = None
                    errors.append(f"{itf.name}: {exc}")
                if _fetch_cache is not None:
                    _fetch_cache[itf.id] = rows
            if rows:  # 有响应 → 解析 upsert + 标记成功 + 优先链命中即停
                fetched = len(rows)
                synced += await self._upsert_masters(itf, rows)
                await self._mark_success(itf.id)
                # 记录本次实际使用的接口与提供方（供前端展示「本次同步来源」+ 各接口获取条数）
                provider = await self.session.get(
                    SecuritiesDataProvider, itf.provider_id
                )
                used = {
                    "providerId": itf.provider_id,
                    "providerName": provider.name if provider else itf.provider_id,
                    "interfaceId": itf.id,
                    "interfaceName": itf.name,
                    "fetched": fetched,
                    "status": "ok",
                }
                break
            # 无响应：计数，继续下一接口（priority 降级）
            await self._mark_failure(itf)
            failed += 1
        await self.session.flush()
        return {
            "synced": synced,
            "failed": failed,
            "errors": errors,
            "used": used,
        }

    async def sync_all_security_masters(self) -> dict[str, Any]:
        """遍历全部 MASTER_LIST 接口 asset_class 数组展开后的 distinct 类别，逐个同步。

        多选优化：同一接口服务多个 asset_class 时，其原始拉取按接口 id 缓存
        （见 sync_security_masters 的 _fetch_cache），保证同端点整轮只请求一次。
        """
        rows = (
            await self.session.execute(
                self._active_provider_join(
                    select(func.unnest(QuoteInterface.asset_class)).where(
                        QuoteInterface.category_id == MASTER_LIST_CAT_ID,
                        QuoteInterface.enabled == True,  # noqa: E712
                        QuoteInterface.asset_class.isnot(None),
                    )
                ).distinct()
            )
        ).all()
        asset_classes = [r[0] for r in rows if r[0]]
        synced = 0
        failed = 0
        errors: list[str] = []
        used_list: list[dict[str, Any]] = []
        # 按接口 id 缓存原始行：服务多 asset_class 的接口整轮只请求一次
        fetch_cache: dict[str, Optional[list[Any]]] = {}
        for ac in asset_classes:
            res = await self.sync_security_masters(ac, _fetch_cache=fetch_cache)
            synced += res["synced"]
            failed += res["failed"]
            errors.extend(res["errors"])
            if res.get("used"):
                used_list.append(res["used"])
        # 跨资产类别去重（按 interfaceId，camelCase 键，与 used dict 一致）
        seen: set[str] = set()
        used_deduped: list[dict[str, Any]] = []
        for u in used_list:
            if u["interfaceId"] in seen:
                continue
            seen.add(u["interfaceId"])
            used_deduped.append(u)
        # 自愈：统一 code 为「交易所前缀 + 数字」并合并存量重复行（不同源带/不带交易所字母导致的历史重复）
        removed = await self._normalize_and_dedupe_masters()
        return {
            "synced": synced,
            "failed": failed,
            "errors": errors,
            "used": used_deduped,
            "deduped": removed,
        }

    def _prepare_master_rows(
        self, itf: QuoteInterface, rows: list[Any]
    ) -> list[dict[str, Any]]:
        """第一遍：纯 CPU 归一化（无查库），把原始行整理为待 upsert 载荷。

        含交易所/资产类别推断、规范码归一与拼音首字母（pypinyin 为纯 CPU 计算，
        全市场万行级时须在 ``asyncio.to_thread`` 中执行，避免阻塞事件循环）。

        code 槽禁用 F4 中文兜底（``include_legacy_code_fallback=False``），与 HEAD
        ``_prepare_master_rows`` 的「接口配置的代码列 or "code"」单候选语义逐行等价：
        分红/公告用途接口经本链路（``dividend_sync.query`` → ``_upsert_masters``）时
        **不得**因中文兜底多取到行（D2）。
        """
        compiled = resolve_fields(itf, include_legacy_code_fallback=False)
        rows, _dropped = self._filter_required_rows(itf, compiled, rows)
        fields = index_by_slot(compiled)
        code_field = fields.get(SLOT_CODE)
        name_field = fields.get(SLOT_NAME)
        exchange_field = fields.get(SLOT_EXCHANGE)

        payload: list[dict[str, Any]] = []
        for r in rows:
            code = code_field.get(r) if code_field else None
            if code is None:
                continue
            raw_code = str(code)
            name = name_field.get(r) if name_field else None
            name = str(name) if name is not None else raw_code
            # 丢弃类别（按 fund-classification-rules.md）：老三板/全国股转(4xxxxx)、
            # 北交所旧段(8xxxxx) 不写入 securities 主数据表，直接跳过。
            if is_dropped(raw_code, name):
                continue
            # 交易所推断须用原始 code（如 bj920021→BJ、sh600000→SH、hk00700→HK），先于归一化
            exchange = exchange_field.get(r) if exchange_field else None
            if not exchange:
                exchange = infer_exchange(raw_code)
            # 存储用「交易所前缀 + 数字」：不同源（000001 / 000001.SZ / sh600000）统一规范，
            # 落到同一 (asset_class, code) → 命中已存在行 UPDATE 而非追加 → 去重（如 2 个平安银行）；
            code = _normalize_master_code(raw_code, exchange)
            pinyin = _compute_pinyin_initials(name)
            # 行级资产类别：逐行按代码前缀 + 交易所 + 名称推断（与持仓 type 同源；
            # 混合段场内基金需靠名称标记 ETF/LOF/REIT/封闭 判定场内）
            asset_class = infer_security_type(code, exchange, name)
            # 指数前缀修正：000xxx 上证指数强制 sh、399xxx 深证指数强制 sz，
            # 防源数据误带前缀（如 sz000012 国债指数）导致跨市场撞码
            if asset_class == SecurityType.INDEX:
                exchange = classify_security(code, name).get("exchange") or exchange
                digits = re.sub(r"\D", "", code)
                code = f"{EXCHANGE_PREFIX.get(exchange or '', '')}{digits}"
            # 北交所 920xxx 段强制 bj 前缀：源数据（如小熊 /stock/all）将 920 段误带 sz 前缀，
            # 若不强归一，会按 sz920xxx 建新行，撞上历史已自愈为 bj920xxx 记录的派生 id
            # （securities_pkey 唯一约束冲突）
            if re.fullmatch(r"920\d{3}", re.sub(r"\D", "", code)):
                exchange = "BJ"
                digits = re.sub(r"\D", "", code)
                code = f"bj{digits}"
            payload.append(
                {
                    "code": code,
                    "name": name,
                    "exchange": exchange,
                    "pinyin": pinyin,
                    "asset_class": asset_class,
                }
            )
        return payload

    async def _upsert_masters(self, itf: QuoteInterface, rows: list[Any]) -> int:
        """把原始行 upsert 进 securities 系统主数据目录表（ADR-003 后仅主数据行）。

        行级 asset_class 由代码前缀 + 交易所**逐行推断**（infer_security_type，与组合持仓 type 同源）：
        港股经交易所识别归 HK_STOCK，无法可靠区分的类（如场外基金）落 UNCATEGORIZED；
        接口 asset_class 仅用于同步选源批次归属，不再强制打标。

        性能：第一遍纯 CPU 归一化放 ``asyncio.to_thread``（pypinyin/正则不阻塞事件循环）；
        第二遍一次性载入存量 ``(asset_class, code) → Security`` 映射，替代逐行 SELECT
        （全市场万行级时由 N 次往返降为 ⌈N/1000⌉ 次）。
        """
        payload = await asyncio.to_thread(self._prepare_master_rows, itf, rows)
        # 抓到行却零产出 = 配置错位（典型：code 槽 source 填成源站实际列名之外的值，
        # 如「新浪-分红配股」响应无代码列却配 'code' → 逐行取空 → 全量跳过）。
        # 与 dividend_sync 的逐期告警同源：杜绝「上万行抓取、0 条入库」全程静默。
        if rows and not payload:
            code_field = index_by_slot(
                resolve_fields(itf, include_legacy_code_fallback=False)
            ).get(SLOT_CODE)
            logger.warning(
                "接口「%s」返回 %s 行但可建主数据 0 条："
                "疑似 code 槽 source=%r 与源返回列名不匹配（或源站响应不含代码列）",
                itf.name, len(rows), code_field.source if code_field else None,
            )

        key_list = list({(p["asset_class"], p["code"]) for p in payload})
        existing_map: dict[tuple[Any, str], Security] = {}
        chunk_size = 1000
        for i in range(0, len(key_list), chunk_size):
            chunk = key_list[i : i + chunk_size]
            existing_rows = (
                await self.session.execute(
                    select(Security).where(
                        tuple_(Security.asset_class, Security.code).in_(chunk)
                    )
                )
            ).scalars().all()
            for sec in existing_rows:
                existing_map[(sec.asset_class, sec.code)] = sec

        count = 0
        for p in payload:
            key = (p["asset_class"], p["code"])
            existing = existing_map.get(key)
            if existing is None:
                sec = Security(
                    id=master_id_for(p["asset_class"], p["code"]),
                    asset_class=p["asset_class"],
                    code=p["code"],
                    name=p["name"],
                    exchange=p["exchange"],
                    pinyin_initials=p["pinyin"],
                )
                self.session.add(sec)
                # 同批重复行命中同一键：后续行走 UPDATE 分支，不重复 INSERT
                existing_map[key] = sec
            else:
                existing.asset_class = p["asset_class"]
                existing.name = p["name"]
                existing.exchange = p["exchange"]
                existing.pinyin_initials = p["pinyin"]
            count += 1
        await self.session.flush()
        return count
