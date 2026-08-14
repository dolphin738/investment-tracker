"""实时行情同步服务 — 分类级接口优先级链（ADR-002 方案 X）。

消费端入口，取代旧 `get_active_provider` 全局单一活跃源模型：

- ``fallback_fetch(category_id, codes)``：按 ``priority`` 升序顺序调用该分类下
  ``enabled`` 接口，返回非空业务数据即停止；其余情况（超时 / 连接错误 / HTTP 5xx /
  鉴权失败 / **HTTP 200 但业务返回空**，定义见 ADR-002 §3 Q1）计为无响应，向下一接口。
- ``sync_portfolio_prices(portfolio_id)``：遍历组合涉及分类，按 code 匹配证券 upsert
  ``SecurityPrice``（含 ``fetched_at`` / ``source``），再 ``recalculateRange`` 重建快照/净值。
- ``sync_security_masters(asset_class?)`` / ``sync_all_security_masters()``：配置驱动同步
  系统级证券主数据（purpose=MASTER_LIST 接口，复用 priority 降级链，零硬编码数据源）。
- ``test_single_interface(interface_id, params, codes)``：用调用方 params 单接口测试，
  原样回传 raw+parsed，不计入 consecutive_failures。

失败计数与告警去重均落 DB（多实例安全）：
- 失败：``consecutive_failures`` 原子自增。
- 成功：复位 ``consecutive_failures=0, alerted=False``。
- 达阈值且 ``alerted=False``：``UPDATE ... SET alerted=True ... RETURNING`` 抢占，
  保证多实例仅一个实例发出告警（Q2 落点由上层负责）。
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import httpx
import pypinyin
from pypinyin import Style
from sqlalchemy import delete as sa_delete
from sqlalchemy import exists as sa_exists
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.date_utils import today_app_tz
from app.models.enums import InterfacePurpose, SecurityType
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import PortfolioSecurity, Security, SecurityPrice
from app.services.notification import NotificationService
from app.services.recalculation import RecalculationService

# —— 可配置阈值（ADR-002 §3 Q4 默认 3）——
FAILURE_THRESHOLD: int = 3
# 单接口默认超时（秒）
DEFAULT_TIMEOUT: int = 5
# 单链总超时预算（秒，ADR-002 §2.3 封顶 ≤8s）
CHAIN_BUDGET: int = 8


@dataclass
class FetchResult:
    """一次分类级 fallback 的结果。"""

    prices: dict[str, Decimal]
    source: Optional[str]


def _infer_exchange(code: str) -> Optional[str]:
    """代码前缀启发式推断交易所（缺失 resp_exchange_field 时兜底，§11.4）。"""
    if not code:
        return None
    c = str(code).lower()
    if c.startswith("sh"):
        return "SH"  # 上交所（含代码自带前缀，如 sh600000）
    if c.startswith("sz"):
        return "SZ"  # 深交所（如 sz301141）
    if c.startswith("bj"):
        return "BJ"  # 北交所（如 bj920021）
    head = code[0]
    if head in ("6", "9"):
        return "SH"  # 上交所
    if head in ("0", "3"):
        return "SZ"  # 深交所
    if head in ("8", "4"):
        return "BJ"  # 北交所
    if head == "5":
        return "SH"  # 基金（上交所）
    if len(code) <= 5:
        return "HK"  # 港股 5 位码
    return None


def _normalize_master_code(raw: str) -> str:
    """主数据代码统一为纯数字串（去交易所字母，保留前导零）。

    不同数据源代码格式不一（``"000001"`` / ``"000001.SZ"`` / ``"sh600000"`` / ``"00700.HK"``），
    统一规范为数字串，供 ``(asset_class, code)`` 唯一约束去重 + 前端纯数字展示：

    - 去交易所后缀（``.SH``/``.SZ``/``.HK``/``.BJ`` 等分割符后部分）
    - 去前导交易所字母（``sh``/``sz``/``bj``/``hk``）
    - 仅保留数字（兜底清残留非数字字符）

    例：``sh600000``→``600000``，``600000.SH``→``600000``，``000001.SZ``→``000001``，
    ``00700.HK``→``00700``。无数字可提取时回退原始串（如纯字母代码），不丢数据。
    """
    if not raw:
        return raw
    s = str(raw).strip()
    # 去交易所后缀：首个 . - _ 分隔符之后的部分（如 .SZ/.SH/.HK）
    s = re.split(r"[.\-_]", s, maxsplit=1)[0]
    # 去前导交易所字母（如 sh/sz/bj/hk）
    s = re.sub(r"^[a-zA-Z]+", "", s)
    # 仅保留数字（兜底清残留非数字字符）
    digits = re.sub(r"\D", "", s)
    return digits if digits else s


def _row_get(row: Any, field: Optional[str]) -> Any:
    """从行取值：dict 行按字段名；数组行按位置下标（resp_* 配置填 "0"/"1"）。

    部分行情源（如小熊同学 /stock/all）返回 [[code, name], ...] 数组行——
    无字段名可查，需在接口配置里把 resp_code_field/resp_name_field 填为整数下标；
    field 非数字下标时数组行返回 None。
    """
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(field)
    if isinstance(row, (list, tuple)):
        if field and str(field).isdigit():
            idx = int(field)
            return row[idx] if 0 <= idx < len(row) else None
        return None
    return None


def _compute_pinyin_initials(name: str) -> Optional[str]:
    """名称 → 拼音首字母（如 贵州茅台→gzm）；异常时返回 None 不阻断同步。"""
    if not name:
        return None
    try:
        initials = pypinyin.pinyin(name, style=Style.FIRST_LETTER, heteronym=False)
        return "".join(seg[0].lower() for seg in initials if seg)
    except Exception:
        return None


class MarketDataSyncService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        # 最近一次 HTTPS 调用的上游状态码（测试端点回传用；SDK 接口为 None）
        self._last_http_status: Optional[int] = None

    # ------------------------------------------------------------------ #
    # 顺序 fallback 链
    # ------------------------------------------------------------------ #
    def _active_provider_join(self, stmt):
        """在 ``select(QuoteInterface[.<列>])`` 上 JOIN 所属提供方并过滤 enabled。

        提供方级开关（``SecuritiesDataProvider.enabled``）是「唯一开关；禁用后不参与解析」，
        故所有选源路径都必须连表过滤提供方 enabled，不能只看接口级 ``enabled``
        （否则停用提供方、但其下接口仍 enabled 时会被照常选用 —— 见 #1 修复）。
        """
        return stmt.join(
            SecuritiesDataProvider,
            QuoteInterface.provider_id == SecuritiesDataProvider.id,
        ).where(SecuritiesDataProvider.enabled == True)  # noqa: E712

    async def _interfaces_for_category(self, category_id: str) -> list[QuoteInterface]:
        stmt = (
            select(QuoteInterface)
            .where(
                QuoteInterface.category_id == category_id,
                QuoteInterface.enabled == True,  # noqa: E712
            )
        )
        stmt = self._active_provider_join(stmt)
        stmt = stmt.order_by(
            QuoteInterface.priority.is_(None),
            QuoteInterface.priority,
        )
        rows = await self.session.execute(stmt)
        return list(rows.scalars().all())

    async def fallback_fetch(
        self, category_id: str, codes: Optional[list[str]] = None
    ) -> FetchResult:
        """顺序调用该分类接口，返回 ``{code: price}`` 与命中来源。

        仅当某接口返回**非空业务数据**（可解析出 code→price）才视为「有响应」并停止；
        其余情况（含「HTTP 200 但业务返回空」）计为无响应、向下一接口（ADR-002 §3 Q1）。
        """
        interfaces = await self._interfaces_for_category(category_id)
        if not interfaces:
            return FetchResult(prices={}, source=None)
        for itf in interfaces:
            try:
                rows = await self._call_interface(itf, codes)
            except Exception:
                rows = None
            if rows:  # 非空业务数据 → 有响应
                await self._mark_success(itf.id)
                provider = await self.session.get(
                    SecuritiesDataProvider, itf.provider_id
                )
                source = f"{provider.name}/{itf.name}" if provider else itf.name
                return FetchResult(prices=rows, source=source)
            # 无响应：计数
            await self._mark_failure(itf)
        return FetchResult(prices={}, source=None)

    # ------------------------------------------------------------------ #
    # 单次接口调用（可被子类/测试 monkeypatch，避免真实网络）
    # ------------------------------------------------------------------ #
    async def _call_interface(
        self, itf: QuoteInterface, codes: Optional[list[str]]
    ) -> dict[str, Decimal]:
        """价格行情分派：返回 {code: price}（供 fallback_fetch 使用）。

        access_method 属于所属 SecuritiesDataProvider（QuoteInterface 无该列），
        分派时经 provider 取用（对齐 _fetch_https_raw/_fetch_sdk_raw 的取法）。
        """
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        access_method = provider.access_method if provider is not None else None
        if access_method == "https":
            return await self._fetch_https(itf, codes)
        if access_method == "sdk":
            return await self._fetch_sdk(itf, codes)
        raise ValueError(f"不支持的接入方式: {access_method}")

    async def _call_interface_raw(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        """原始行分派：返回 ``list[dict]``（供主数据同步 / 单接口测试，使用调用方 params）。

        https 回传 resp.json() 归一化后的行；sdk 回传 DataFrame.to_dict('records')。
        access_method 由所属 SecuritiesDataProvider 提供（同 _call_interface）。
        """
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        access_method = provider.access_method if provider is not None else None
        if access_method == "https":
            return await self._fetch_https_raw(itf, params, codes)
        if access_method == "sdk":
            return await self._fetch_sdk_raw(itf, params, codes)
        raise ValueError(f"不支持的接入方式: {access_method}")

    # —— 原始行归一化（JSON list / {data:[...]} / 单对象）——
    def _normalize_rows(self, payload: Any) -> list[Any]:
        """归一化为行列表：dict 行（字段映射）或数组行（位置下标）。

        保留数组行——部分行情源（如小熊同学 /stock/all）返回 [[code, name], ...]，
        解析侧按 resp_* 配置的整数下标取值（见 _row_get）。
        """
        if isinstance(payload, list):
            return [r for r in payload if isinstance(r, (dict, list))]
        if isinstance(payload, dict):
            for key in ("data", "list", "items", "result"):
                v = payload.get(key)
                if isinstance(v, list):
                    return [r for r in v if isinstance(r, (dict, list))]
            return [payload]
        return []

    async def _fetch_https_raw(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        config = (provider.config or {}) if provider is not None else {}
        base_url = config.get("base_url")
        if not base_url or not itf.endpoint:
            raise ValueError("HTTPS 接口缺少 base_url 或 endpoint")
        url = base_url.rstrip("/") + "/" + itf.endpoint.lstrip("/")
        params = {
            k: (",".join(v) if isinstance(v, list) else v)
            for k, v in (params or {}).items()
        }
        if codes is not None:
            # 通用做法：以逗号拼接 code 列表覆盖 code 参数（如小熊同学 /stock）
            params["code"] = ",".join(codes)
        timeout = itf.timeout or DEFAULT_TIMEOUT
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(itf.http_method or "GET", url, params=params)
        self._last_http_status = resp.status_code
        if resp.status_code >= 500:
            raise RuntimeError(f"上游 5xx: {resp.status_code}")
        if resp.status_code in (401, 403):
            raise RuntimeError(f"鉴权失败: {resp.status_code}")
        resp.raise_for_status()
        return self._normalize_rows(resp.json())

    async def _fetch_sdk_raw(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        """SDK 接入方式（如 akshare）：懒导入 SDK，按 resp 字段映射解析 DataFrame→list[dict]。

        仅当 akshare 等 SDK 实际被调用时才 import，避免无 SDK 环境（测试 / 未安装）
        在模块加载期即要求安装导致启动崩溃。
        """
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        config = (provider.config or {}) if provider is not None else {}
        # SDK 顶层函数名：优先取接口 endpoint（UI 约定「SDK 时为函数名」，见接口对话框占位），
        # 兼容旧配置 provider.config.sdk_func（管理面 SDK 表单只收集 sdk_name，函数名在接口上）。
        sdk_func = (itf.endpoint or "").strip() or config.get("sdk_func")
        if not isinstance(sdk_func, str) or not sdk_func:
            raise ValueError(
                "SDK 接入方式必须在接口「调用路径」填写 akshare 顶层函数名"
                "（或提供方 config.sdk_func 配置）"
            )
        # 懒导入：模块级不 import akshare（见文件头约束）
        import akshare  # noqa: PLC0415

        func = getattr(akshare, sdk_func, None)
        if func is None:
            raise ValueError(f"akshare 中不存在函数 {sdk_func}")
        params = {**(params or {})}
        if codes:
            # codes 非空时透传（如 stock_zh_a_spot 按 code 入参）
            params = {**params, "codes": codes}
        df = func(**params)
        if df is None or getattr(df, "empty", False):
            return []
        if hasattr(df, "to_dict"):
            return [dict(r) for r in df.to_dict("records")]
        if hasattr(df, "iterrows"):  # 兼容非 pandas DataFrame 替身（测试）
            return [
                (r.to_dict() if hasattr(r, "to_dict") else dict(r))
                for _, r in df.iterrows()
            ]
        return []

    async def _fetch_https(
        self, itf: QuoteInterface, codes: Optional[list[str]]
    ) -> dict[str, Decimal]:
        rows = await self._fetch_https_raw(itf, itf.params, codes)
        return self._parse_price_rows(itf, rows)

    async def _fetch_sdk(
        self, itf: QuoteInterface, codes: Optional[list[str]]
    ) -> dict[str, Decimal]:
        rows = await self._fetch_sdk_raw(itf, itf.params, codes)
        return self._parse_price_rows(itf, rows)

    def _parse_price_rows(self, itf: QuoteInterface, rows: list[Any]) -> dict[str, Decimal]:
        """把原始行解析为 ``{code: price}``。业务空 → 返回 ``{}``（触发向下）。"""
        code_field = itf.resp_code_field or "code"
        price_field = itf.resp_price_field or "price"
        out: dict[str, Decimal] = {}
        for r in rows:
            code = _row_get(r, code_field)
            price = _row_get(r, price_field)
            if code is None or price is None:
                continue
            try:
                # 价格 code 同样规范为数字串，与主数据 digits-only 对齐（否则带后缀源匹配不到）
                out[_normalize_master_code(str(code))] = Decimal(str(price))
            except (InvalidOperation, ValueError, TypeError):
                continue
        return out

    def _parse_test_rows(self, itf: QuoteInterface, rows: list[Any]) -> dict[str, str]:
        """测试端点解析：{code→price 字符串}（按 resp_code_field/resp_price_field）。"""
        code_field = itf.resp_code_field or "code"
        price_field = itf.resp_price_field or "price"
        out: dict[str, str] = {}
        for r in rows:
            code = _row_get(r, code_field)
            price = _row_get(r, price_field)
            if code is None or price is None:
                continue
            out[str(code)] = str(price)
        return out

    # ------------------------------------------------------------------ #
    # 失败计数 / 告警抢占（DB 原子）
    # ------------------------------------------------------------------ #
    async def _mark_success(self, interface_id: str) -> None:
        await self.session.execute(
            update(QuoteInterface)
            .where(QuoteInterface.id == interface_id)
            .values(consecutive_failures=0, alerted=False)
        )
        await self.session.flush()

    async def _mark_failure(self, itf: QuoteInterface) -> None:
        interface_id = itf.id
        # 原子自增
        await self.session.execute(
            update(QuoteInterface)
            .where(QuoteInterface.id == interface_id)
            .values(consecutive_failures=QuoteInterface.consecutive_failures + 1)
        )
        await self.session.flush()
        # 达阈值且未告警 → 抢占置位（RETURNING 确认本实例抢到）
        row = (
            await self.session.execute(
                select(QuoteInterface.consecutive_failures, QuoteInterface.alerted).where(
                    QuoteInterface.id == interface_id
                )
            )
        ).first()
        if row and row[0] >= FAILURE_THRESHOLD and not row[1]:
            claimed = (
                await self.session.execute(
                    update(QuoteInterface)
                    .where(
                        QuoteInterface.id == interface_id,
                        QuoteInterface.alerted == False,  # noqa: E712
                    )
                    .values(alerted=True)
                    .returning(QuoteInterface.id)
                )
            ).scalar_one_or_none()
            # claimed 非 None 表示本实例抢到告警：写一条站内信（Q2 落点）
            if claimed is not None:
                await NotificationService(self.session).create(
                    level="warning",
                    title=f"接口「{itf.name}」连续 {FAILURE_THRESHOLD} 次无响应",
                    message=(
                        f"提供方接口 {itf.name} 已连续 {FAILURE_THRESHOLD} 次无响应，"
                        f"已暂停重复告警，请检查。"
                    ),
                    related_type="quote_interface",
                    related_id=itf.id,
                )
        await self.session.flush()

    # ------------------------------------------------------------------ #
    # 组合级同步
    # ------------------------------------------------------------------ #
    async def _upsert_price(
        self,
        portfolio_id: str,
        security_id: str,
        price: Decimal,
        as_of: date,
        source: Optional[str],
    ) -> None:
        existing = (
            await self.session.execute(
                select(SecurityPrice).where(
                    SecurityPrice.portfolio_id == portfolio_id,
                    SecurityPrice.security_id == security_id,
                    SecurityPrice.as_of == as_of,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            existing = SecurityPrice(
                portfolio_id=portfolio_id,
                security_id=security_id,
                price=price,
                as_of=as_of,
            )
            self.session.add(existing)
        else:
            existing.price = price
        existing.fetched_at = datetime.now(timezone.utc)
        existing.source = source
        await self.session.flush()

    async def sync_portfolio_prices(
        self, portfolio_id: str, as_of: Optional[date] = None
    ) -> dict[str, Any]:
        """同步某组合全部证券的实时行情并重建快照/净值。

        返回结构化结果 ``{synced, failed, skipped, errors}``（禁返裸 int，见 ADR-002 §2.6）。
        """
        as_of = as_of or today_app_tz()
        sec_rows = await self.session.execute(
            select(PortfolioSecurity.id, Security.code)
            .join(Security, PortfolioSecurity.master_id == Security.id)
            .where(PortfolioSecurity.portfolio_id == portfolio_id)
        )
        securities = {code: sid for sid, code in sec_rows.all()}
        if not securities:
            return {"synced": 0, "failed": 0, "skipped": 0, "errors": []}
        codes = list(securities.keys())

        # 涉及分类：有 enabled 接口（且所属提供方启用）的分类
        cat_rows = await self.session.execute(
            self._active_provider_join(
                select(QuoteInterface.category_id).where(
                    QuoteInterface.enabled == True,  # noqa: E712
                    QuoteInterface.category_id.isnot(None),
                )
            ).distinct()
        )
        category_ids = [c for (c,) in cat_rows.all() if c]

        synced = 0
        failed = 0
        errors: list[str] = []
        for cat_id in category_ids:
            try:
                result = await self.fallback_fetch(cat_id, codes)
            except Exception as exc:  # 整条链异常（不应发生，fallback 已吞异常）
                failed += 1
                errors.append(str(exc))
                continue
            for code, price in result.prices.items():
                sid = securities.get(code)
                if sid is None:
                    continue
                await self._upsert_price(portfolio_id, sid, price, as_of, result.source)
                synced += 1

        # 重建快照/净值（不 commit，由调用方提交）
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, as_of, as_of
        )
        return {"synced": synced, "failed": failed, "skipped": 0, "errors": errors}

    # ------------------------------------------------------------------ #
    # 证券主数据同步（配置驱动，purpose=MASTER_LIST，§7 ① / §11）
    # ------------------------------------------------------------------ #
    async def sync_security_masters(
        self, asset_class: Optional[SecurityType] = None
    ) -> dict[str, Any]:
        """配置驱动同步某资产类别的证券主数据（purpose=MASTER_LIST 接口，priority 降级链）。

        仅选 ``portfolio_id IS NULL`` 的系统主数据行承载全市场列表；命中优先链即停。
        返回结构化结果 ``{synced, failed, errors}``。
        """
        stmt = (
            select(QuoteInterface)
            .where(
                QuoteInterface.purpose == InterfacePurpose.MASTER_LIST,
                QuoteInterface.enabled == True,  # noqa: E712
            )
        )
        stmt = self._active_provider_join(stmt)
        if asset_class is not None:
            stmt = stmt.where(QuoteInterface.asset_class == asset_class)
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
            try:
                rows = await self._call_interface_raw(itf, itf.params, None)
            except Exception as exc:
                rows = None
                errors.append(f"{itf.name}: {exc}")
            if rows:  # 有响应 → 解析 upsert + 标记成功 + 优先链命中即停
                synced += await self._upsert_masters(itf, rows)
                await self._mark_success(itf.id)
                # 记录本次实际使用的接口与提供方（供前端展示「本次同步来源」）
                provider = await self.session.get(
                    SecuritiesDataProvider, itf.provider_id
                )
                used = {
                    "providerId": itf.provider_id,
                    "providerName": provider.name if provider else itf.provider_id,
                    "interfaceId": itf.id,
                    "interfaceName": itf.name,
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
        """遍历全部 MASTER_LIST 接口的 distinct asset_class，逐个同步（数据驱动，零硬编码）。"""
        rows = (
            await self.session.execute(
                self._active_provider_join(
                    select(QuoteInterface.asset_class).where(
                        QuoteInterface.purpose == InterfacePurpose.MASTER_LIST,
                        QuoteInterface.enabled == True,  # noqa: E712
                        QuoteInterface.asset_class.isnot(None),
                    )
                ).distinct()
            )
        ).all()
        asset_classes = [r[0] for r in rows if r[0] is not None]
        synced = 0
        failed = 0
        errors: list[str] = []
        used_list: list[dict[str, Any]] = []
        for ac in asset_classes:
            res = await self.sync_security_masters(ac)
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
        # 自愈：统一 code 为数字串并合并存量重复行（不同源带/不带交易所字母导致的历史重复）
        removed = await self._normalize_and_dedupe_masters()
        return {
            "synced": synced,
            "failed": failed,
            "errors": errors,
            "used": used_deduped,
            "deduped": removed,
        }

    async def _normalize_and_dedupe_masters(self) -> int:
        """扫描系统主数据：统一 code 为数字串，并合并 ``(asset_class, code)`` 碰撞的重复行。

        修复旧数据：不同源带/不带交易所字母（如 ``"000001"`` vs ``"000001.SZ"``）曾绕过
        ``(asset_class, code)`` 唯一约束被当成两条追加写入。下次 ``sync_all`` 自动自愈，
        清空「如 2 个平安银行」类存量重复。

        合并规则：按 ``(asset_class, 规范code)`` 分组，保留 ``updated_at`` 最新行，其余删除；
        删除前把其 ``portfolio_securities`` 引用安全转移到保留行（保留行已在该组合持有同一标的
        → 属重复持仓，直接丢弃该残留引用），避免误删用户持仓。
        （securities 现为纯目录表，无 portfolio_id 列，故直接全表扫描。）
        """
        rows = (
            await self.session.execute(select(Security))
        ).scalars().all()
        groups: dict[tuple, list[Security]] = {}
        for s in rows:
            norm = _normalize_master_code(s.code)
            groups.setdefault((s.asset_class, norm), []).append(s)

        removed = 0
        ps_alias = aliased(PortfolioSecurity)
        for (asset_class, norm), items in groups.items():
            if len(items) == 1:
                if items[0].code != norm:
                    items[0].code = norm  # 规范化孤立行
                continue
            items.sort(key=lambda x: (x.updated_at or datetime.min), reverse=True)
            keep = items[0]
            # 先安全转移并删除重复行；此时 keep.code 暂不动，避免与尚存的 dup 撞唯一约束
            for dup in items[1:]:
                # 转移组合持仓引用到 keep：仅当 keep 尚未在该组合持有该标的时
                await self.session.execute(
                    update(PortfolioSecurity)
                    .where(
                        PortfolioSecurity.master_id == dup.id,
                        ~sa_exists().where(
                            ps_alias.portfolio_id == PortfolioSecurity.portfolio_id,
                            ps_alias.master_id == keep.id,
                        ),
                    )
                    .values(master_id=keep.id)
                )
                # 清除无法转移（keep 已持有 → 属重复持仓）的残留引用
                await self.session.execute(
                    sa_delete(PortfolioSecurity).where(
                        PortfolioSecurity.master_id == dup.id
                    )
                )
                await self.session.delete(dup)
                removed += 1
            await self.session.flush()  # 先落库删掉 dup，腾出唯一键
            keep.code = norm  # 再规范化保留行（此时无撞键风险）
        await self.session.flush()
        return removed

    async def _upsert_masters(self, itf: QuoteInterface, rows: list[Any]) -> int:
        """把原始行 upsert 进 securities 系统主数据目录表（ADR-003 后仅主数据行）。

        asset_class 字段统一使用接口配置的 asset_class（如 STOCK），用于主数据唯一约束；
        目录表不再承载 type（类别维度由 asset_class 承担，组合行 type 由代码前缀推断）。
        """
        # asset_class 用于主数据唯一约束（防止不同资产类别代码碰撞）
        asset_class = itf.asset_class or SecurityType.STOCK
        code_field = itf.resp_code_field or "code"
        name_field = itf.resp_name_field or "name"
        exchange_field = itf.resp_exchange_field

        count = 0
        for r in rows:
            code = _row_get(r, code_field)
            if code is None:
                continue
            raw_code = str(code)
            name = _row_get(r, name_field)
            name = str(name) if name is not None else raw_code
            # 交易所推断须用原始 code（如 bj920021→BJ、sh600000→SH），先于归一化
            exchange = _row_get(r, exchange_field) if exchange_field else None
            if not exchange:
                exchange = _infer_exchange(raw_code)
            # 存储用「纯数字 code」：剥离交易所字母，保证不同源（000001 / 000001.SZ / sh000001）
            # 落到同一 (asset_class, code) → 命中已存在行 UPDATE 而非追加 → 去重（如 2 个平安银行）
            code = _normalize_master_code(raw_code)
            pinyin = _compute_pinyin_initials(name)

            existing = (
                await self.session.execute(
                    select(Security).where(
                        Security.asset_class == asset_class,
                        Security.code == code,
                    )
                )
            ).scalar_one_or_none()

            if existing is None:
                sec = Security(
                    asset_class=asset_class,
                    code=code,
                    name=name,
                    exchange=exchange,
                    pinyin_initials=pinyin,
                )
                self.session.add(sec)
            else:
                existing.asset_class = asset_class
                existing.name = name
                existing.exchange = exchange
                existing.pinyin_initials = pinyin
            count += 1
        await self.session.flush()
        return count

    # ------------------------------------------------------------------ #
    # 单接口测试（右栏数据源，§5.2；不计入 consecutive_failures 告警）
    # ------------------------------------------------------------------ #
    async def test_single_interface(
        self, interface_id: str, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> dict[str, Any]:
        """用调用方 params 调用单接口并原样回传 raw+parsed；不计入 consecutive_failures。"""
        itf = await self.session.get(QuoteInterface, interface_id)
        if itf is None:
            return {
                "ok": False,
                "status": "error",
                "elapsedMs": 0.0,
                "raw": None,
                "parsed": None,
                "error": "接口不存在",
                "interfaceId": interface_id,
            }
        self._last_http_status = None
        start = time.perf_counter()
        try:
            rows = await self._call_interface_raw(itf, params, codes)
        except Exception as exc:
            elapsed = time.perf_counter() - start
            return {
                "ok": False,
                "status": "error",
                "httpStatus": self._last_http_status,
                "elapsedMs": round(elapsed * 1000, 2),
                "raw": None,
                "parsed": None,
                "error": str(exc),
                "interfaceId": interface_id,
            }
        elapsed = time.perf_counter() - start
        parsed = self._parse_test_rows(itf, rows)
        return {
            "ok": True,
            "status": "success",
            "httpStatus": self._last_http_status,
            "elapsedMs": round(elapsed * 1000, 2),
            "raw": rows,
            "parsed": parsed,
            "interfaceId": interface_id,
        }
