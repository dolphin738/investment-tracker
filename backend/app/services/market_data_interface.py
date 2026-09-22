"""行情「raw 分派 + 单接口试调」mixin。

自 ``market_data_sync`` 按位置拆分而来（ADR-002 / 架构治理 §4）：承载

- ``_call_interface_raw`` / ``call_interface_raw``：原始行分派（P1-4 告警链路统一入口，
  异常计失败后原样抛出、成功即复位）；
- ``_call_interface_raw_dispatch``：按 provider ``access_method`` 分派 https / sdk；
- ``test_single_interface``：右栏数据源试调（原样回传 raw + fieldHits，不计入告警）。

跨 mixin 协作（由门面 MRO 解析，调用点零改动）：

- ``self._fetch_https_raw`` / ``self._fetch_sdk_raw`` → ``MarketDataFetchMixin``；
- ``self._mark_success`` / ``self._mark_failure`` → ``MarketDataPriceMixin``。

依赖方向：``market_data_params ← market_data_fetch ← 本模块``；本模块不得 import 门面
（循环导入）。
"""
from __future__ import annotations

import time
from typing import Any, Optional

from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.response_fields import compute_slot_hit_rates, resolve_fields


class MarketDataInterfaceMixin:
    """raw 分派与单接口试调。"""

    async def _call_interface_raw(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        """原始行分派（P1-4 告警链路统一入口）：异常计失败、成功即复位。

        consecutive_failures ≥3 发站内信（§6.5）此前只挂在 fallback/_call_interface
        调用侧，raw 消费者（分红明细源/公告源/行情源/主数据同步）都不接线——现下沉到
        本层，所有 raw 调用自动继承：异常 → ``_mark_failure`` 后原样抛出；
        成功（含业务空响应）→ ``_mark_success`` 复位。
        """
        try:
            rows = await self._call_interface_raw_dispatch(itf, params, codes)
        except Exception:
            await self._mark_failure(itf)
            raise
        await self._mark_success(itf.id)
        return rows

    async def call_interface_raw(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        """公开原始行分派入口（债务收敛）：供跨服务调用方使用，内部委托 ``_call_interface_raw``。

        既有跨服务代码（``dividend_notice_scan`` 等）曾直接调私有 ``_mds._call_interface_raw``，
        现统一走本公开方法，避免跨服务依赖私有实现。
        """
        return await self._call_interface_raw(itf, params, codes)

    async def _call_interface_raw_dispatch(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        """原始行分派本体：https 回传 resp.json() 归一化后的行；sdk 回传 DataFrame 行。

        access_method 由所属 SecuritiesDataProvider 提供（同 _call_interface）。
        """
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        access_method = provider.access_method if provider is not None else None
        if access_method == "https":
            return await self._fetch_https_raw(itf, params, codes)
        if access_method == "sdk":
            return await self._fetch_sdk_raw(itf, params, codes)
        raise ValueError(f"不支持的接入方式: {access_method}")

    # ------------------------------------------------------------------ #
    # 单接口测试（右栏数据源，§5.2；不计入 consecutive_failures 告警）
    # ------------------------------------------------------------------ #
    async def test_single_interface(
        self, interface_id: str, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> dict[str, Any]:
        """用调用方 params 调用单接口并原样回传 raw+fieldHits；不计入 consecutive_failures。"""
        itf = await self.session.get(QuoteInterface, interface_id)
        if itf is None:
            return {
                "ok": False,
                "status": "error",
                "elapsedMs": 0.0,
                "raw": None,
                "fieldHits": [],
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
                "fieldHits": [],
                # 兜底：异常消息可能为空字符串，回退到异常类型名，避免前端显示「未知错误」
                "error": str(exc) or type(exc).__name__,
                "interfaceId": interface_id,
            }
        elapsed = time.perf_counter() - start
        # 逐槽位命中率：code 槽禁用 F4 中文兜底（与 _parse_price_rows 同口径，D2）。
        # 旧 parsed 字段（code 到 price 的逐条映射）已于 2026-09-16 随前端迁移完成下线；
        # 试调面板改由 fieldHits（汇总命中率与每槽位示例）和 raw（原文）承载。
        field_hits = compute_slot_hit_rates(
            resolve_fields(itf, include_legacy_code_fallback=False), rows
        )
        return {
            "ok": True,
            "status": "success",
            "httpStatus": self._last_http_status,
            "elapsedMs": round(elapsed * 1000, 2),
            "raw": rows,
            "fieldHits": field_hits,
            "rowCount": len(rows),
            "interfaceId": interface_id,
        }
