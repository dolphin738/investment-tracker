"""实时行情同步服务 — 分类级接口优先级链（ADR-002 方案 X）。

消费端入口，取代旧 `get_active_provider` 全局单一活跃源模型：

- ``fallback_fetch(category_id, codes)``：按 ``priority`` 升序顺序调用该分类下
  ``enabled`` 接口，返回非空业务数据即停止；其余情况（超时 / 连接错误 / HTTP 5xx /
  鉴权失败 / **HTTP 200 但业务返回空**，定义见 ADR-002 §3 Q1）计为无响应，向下一接口。
- ``sync_portfolio_prices(portfolio_id)``：遍历组合涉及分类，按 code 匹配证券 upsert
  ``SecurityPrice``（含 ``fetched_at`` / ``source``），再 ``recalculateRange`` 重建快照/净值。

失败计数与告警去重均落 DB（多实例安全）：
- 失败：``consecutive_failures`` 原子自增。
- 成功：复位 ``consecutive_failures=0, alerted=False``。
- 达阈值且 ``alerted=False``：``UPDATE ... SET alerted=True ... RETURNING`` 抢占，
  保证多实例仅一个实例发出告警（Q2 落点由上层负责）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import Security, SecurityPrice
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


class MarketDataSyncService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ------------------------------------------------------------------ #
    # 顺序 fallback 链
    # ------------------------------------------------------------------ #
    async def _interfaces_for_category(self, category_id: str) -> list[QuoteInterface]:
        rows = await self.session.execute(
            select(QuoteInterface)
            .where(
                QuoteInterface.category_id == category_id,
                QuoteInterface.enabled == True,  # noqa: E712
            )
            .order_by(
                QuoteInterface.priority.is_(None),
                QuoteInterface.priority,
            )
        )
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
            await self._mark_failure(itf.id)
        return FetchResult(prices={}, source=None)

    # ------------------------------------------------------------------ #
    # 单次接口调用（可被子类/测试 monkeypatch，避免真实网络）
    # ------------------------------------------------------------------ #
    async def _call_interface(
        self, itf: QuoteInterface, codes: Optional[list[str]]
    ) -> dict[str, Decimal]:
        if itf.access_method == "https":
            return await self._fetch_https(itf, codes)
        # SDK 接入方式 V1 暂未实现（ADR-002 §5 第 5 步）
        raise NotImplementedError("SDK 接入方式将在 V1 后续步骤实现")

    async def _fetch_https(
        self, itf: QuoteInterface, codes: Optional[list[str]]
    ) -> dict[str, Decimal]:
        base_url = (itf.provider.config or {}).get("base_url")
        if not base_url or not itf.endpoint:
            raise ValueError("HTTPS 接口缺少 base_url 或 endpoint")
        url = base_url.rstrip("/") + "/" + itf.endpoint.lstrip("/")
        params: dict[str, Any] = {
            k: (",".join(v) if isinstance(v, list) else v)
            for k, v in (itf.params or {}).items()
        }
        if codes is not None:
            # 通用做法：以逗号拼接 code 列表覆盖 code 参数（如小熊同学 /stock）
            params["code"] = ",".join(codes)
        timeout = itf.timeout or DEFAULT_TIMEOUT
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(
                itf.http_method or "GET", url, params=params
            )
        if resp.status_code >= 500:
            raise RuntimeError(f"上游 5xx: {resp.status_code}")
        if resp.status_code in (401, 403):
            raise RuntimeError(f"鉴权失败: {resp.status_code}")
        resp.raise_for_status()
        return self._parse_rows(itf, resp.json())

    def _parse_rows(self, itf: QuoteInterface, payload: Any) -> dict[str, Decimal]:
        """把响应体解析为 ``{code: price}``。业务空 → 返回 ``{}``（触发向下）。"""
        code_field = itf.resp_code_field or "code"
        price_field = itf.resp_price_field or "price"
        rows: list[dict] = []
        if isinstance(payload, list):
            rows = [r for r in payload if isinstance(r, dict)]
        elif isinstance(payload, dict):
            for key in ("data", "list", "items", "result"):
                v = payload.get(key)
                if isinstance(v, list):
                    rows = [r for r in v if isinstance(r, dict)]
                    break
            else:
                if payload.get(code_field) is not None:
                    rows = [payload]
        if not rows:
            return {}
        out: dict[str, Decimal] = {}
        for r in rows:
            code = r.get(code_field)
            price = r.get(price_field)
            if code is None or price is None:
                continue
            try:
                out[str(code)] = Decimal(str(price))
            except (InvalidOperation, ValueError, TypeError):
                continue
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

    async def _mark_failure(self, interface_id: str) -> None:
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
            # claimed 非 None 表示本实例抢到告警（Q2 落点由上层消费）
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
            select(Security.id, Security.code).where(
                Security.portfolio_id == portfolio_id
            )
        )
        securities = {code: sid for sid, code in sec_rows.all()}
        if not securities:
            return {"synced": 0, "failed": 0, "skipped": 0, "errors": []}
        codes = list(securities.keys())

        # 涉及分类：有 enabled 接口的分类
        cat_rows = await self.session.execute(
            select(QuoteInterface.category_id)
            .where(
                QuoteInterface.enabled == True,  # noqa: E712
                QuoteInterface.category_id.isnot(None),
            )
            .distinct()
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
