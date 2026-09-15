"""行情「价格链路」mixin：分类选源 fallback 链、价格解析、成败计数与组合行情同步。

自 ``market_data_sync`` 按位置拆分而来（ADR-002 / 架构治理 §4）：承载

- 分类级选源（``_interfaces_for_category`` / ``fallback_fetch``）与接入方式分派；
- 原始行 → ``{code: price}`` 解析与 required 槽缺失丢弃；
- ``consecutive_failures`` / ``alerted`` 的 DB 原子计数与告警抢占；
- ``sync_portfolio_prices``（组合行情批量 upsert + 快照/净值重建）。

依赖方向：``market_data_params ← market_data_fetch ← 本模块``；本模块不得 import
门面（循环导入）。``self._fetch_https_raw`` / ``self._fetch_sdk_raw`` 由
``MarketDataFetchMixin`` 提供，MRO 解析到门面类上后可用。
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy import select, update

from app.core.date_utils import today_app_tz
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import PortfolioSecurity, Security, SecurityPrice
from app.services.market_data_params import (
    FAILURE_THRESHOLD,
    QUOTE_CAT_ID,
    FetchResult,
    _normalize_master_code,
)
from app.services.notification import NotificationService
from app.services.recalculation import RecalculationService
from app.services.response_fields import (
    SLOT_CODE,
    SLOT_PRICE,
    filter_required_rows,
    index_by_slot,
    resolve_fields,
)

logger = logging.getLogger(__name__)


class MarketDataPriceMixin:
    """价格链路（选源 fallback + 解析 + 计数告警 + 组合同步）。"""

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
        """把原始行解析为 ``{code: price}``。业务空 → 返回 ``{}``（触发向下）。

        code 槽禁用 F4 中文兜底（``include_legacy_code_fallback=False``），与 HEAD
        ``_parse_price_rows`` 的「接口配置的代码列 or "code"」单候选语义逐行等价（D2）。
        边界 3（NaN / ``pd.NA`` → ``None``）**P1 暂缓至 P2，勿视为已实现**：改造前同样
        原样透传（此处会产出 ``Decimal('NaN')``），未把 NaN 当 0。
        """
        compiled = resolve_fields(itf, include_legacy_code_fallback=False)
        # required 槽缺失整行丢弃 + 计数（边界 6）；若整批被丢 → 返回空 dict，
        # 由既有 fallback_fetch 的「空业务数据 = 无响应」路径复用 consecutive_failures。
        rows, _dropped = self._filter_required_rows(itf, compiled, rows)
        fields = index_by_slot(compiled)
        code_field = fields.get(SLOT_CODE)
        price_field = fields.get(SLOT_PRICE)
        out: dict[str, Decimal] = {}
        for r in rows:
            code = code_field.get(r) if code_field else None
            price = price_field.get(r) if price_field else None
            if code is None or price is None:
                continue
            try:
                # 价格 code 同样规范为「交易所前缀 + 数字」，与主数据对齐（否则带后缀源匹配不到）
                out[_normalize_master_code(str(code))] = Decimal(str(price))
            except (InvalidOperation, ValueError, TypeError):
                continue
        return out

    # ------------------------------------------------------------------ #
    # required 槽缺失 → 整行丢弃 + 计数（边界 6）
    # ------------------------------------------------------------------ #
    def _filter_required_rows(
        self, itf: QuoteInterface, compiled: list[Any], rows: list[Any]
    ) -> tuple[list[Any], int]:
        """按 ``required=true`` 字段整行丢弃 + 计数（同步，供行循环前调用）。

        返回 ``(保留行, 丢弃行数)``；丢弃数始终以 WARNING 记录（与既有「抓到行却零产出」
        告警同源，**不新造告警通道**）。整批被丢时的失败计数由调用方经既有
        ``_mark_failure``（``consecutive_failures`` / ``alerted``）衔接，见
        :meth:`_note_required_drops`。
        """
        kept, dropped = filter_required_rows(compiled, rows)
        if dropped:
            logger.warning(
                "接口「%s」因 required 字段缺失丢弃 %d/%d 行（边界 6：整行丢弃，不补默认值）",
                getattr(itf, "name", None), dropped, len(rows),
            )
        return kept, dropped

    async def _note_required_drops(self, itf: QuoteInterface, dropped: int, total: int) -> None:
        """整批被 required 丢弃 = 无可用响应：计入既有 ``consecutive_failures`` 失败计数。

        仅在 ``dropped == total > 0``（整批丢弃）时触发，达 ``FAILURE_THRESHOLD`` 即由既有
        ``_mark_failure`` 抢占发站内信；不新造告警通道。接口桩无 ``id`` 时不动库。
        """
        if dropped > 0 and dropped >= total and getattr(itf, "id", None):
            await self._mark_failure(itf)

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
    async def _upsert_prices_batch(
        self,
        portfolio_id: str,
        pairs: list[tuple[str, Decimal]],
        as_of: date,
        source: Optional[str],
    ) -> None:
        """批量 upsert 当日行情（同一天一次 SELECT + 批量写入，消除逐行往返）。

        ``pairs`` 为 (security_id, price) 列表；existing 原地改字段，新行批量 add。
        （security_prices 无 (portfolio_id, security_id, as_of) 唯一约束，
        沿用 SELECT-then-write 语义，不引入 on_conflict。）
        """
        if not pairs:
            return
        sids = [sid for sid, _ in pairs]
        existing_rows = (
            await self.session.execute(
                select(SecurityPrice).where(
                    SecurityPrice.portfolio_id == portfolio_id,
                    SecurityPrice.as_of == as_of,
                    SecurityPrice.security_id.in_(sids),
                )
            )
        ).scalars().all()
        by_sid = {r.security_id: r for r in existing_rows}
        fetched_at = datetime.now(timezone.utc)
        for sid, price in pairs:
            row = by_sid.get(sid)
            if row is None:
                self.session.add(
                    SecurityPrice(
                        portfolio_id=portfolio_id,
                        security_id=sid,
                        price=price,
                        as_of=as_of,
                        fetched_at=fetched_at,
                        source=source,
                    )
                )
            else:
                row.price = price
                row.fetched_at = fetched_at
                row.source = source
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

        # 行情同步仅查「证券行情」固定分类（分类即用途，见 reform 方案）；
        # 顺带修掉旧实现"主数据分类也被当行情源"的潜在 bug。
        synced = 0
        failed = 0
        errors: list[str] = []
        result = await self.fallback_fetch(QUOTE_CAT_ID, codes)
        pairs: list[tuple[str, Decimal]] = []
        for code, price in result.prices.items():
            sid = securities.get(code)
            if sid is None:
                continue
            pairs.append((sid, price))
            synced += 1
        await self._upsert_prices_batch(portfolio_id, pairs, as_of, result.source)

        # 重建快照/净值（不 commit，由调用方提交）
        await RecalculationService(self.session).recalculateRange(
            portfolio_id, as_of, as_of
        )
        return {"synced": synced, "failed": failed, "skipped": 0, "errors": errors}
