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
  原样回传 raw+fieldHits，不计入 consecutive_failures。

失败计数与告警去重均落 DB（多实例安全）：
- 失败：``consecutive_failures`` 原子自增。
- 成功：复位 ``consecutive_failures=0, alerted=False``。
- 达阈值且 ``alerted=False``：``UPDATE ... SET alerted=True ... RETURNING`` 抢占，
  保证多实例仅一个实例发出告警（Q2 落点由上层负责）。

实现已按《架构治理规范》§4 拆分到独立模块，本文件仅作**公共 API 门面**：
``MarketDataSyncService`` 由下列 mixin 组装（各 mixin 方法名唯一，MRO 顺序不影响解析），
类内 ``self._xxx(...)`` 调用点零改动。

- 参数与规范化 ``market_data_params``：常量 / 交易所与代码规范化 / 速率解析 / 主数据 id 派生；
- 抓取与归一化 ``market_data_fetch``：限流、共享 HTTP 客户端、HTTPS / SDK 原始抓取；
- 价格链路 ``market_data_price``：分类选源 fallback 链、价格解析、成败计数、组合同步；
- 主数据同步 ``market_data_master``：配置驱动选源编排 + 归一化 + 批量 upsert；
- 主数据自愈 ``market_data_master_heal``：重复行合并 + 派生 id 重算 + 丢弃类别清理；
- raw 分派 ``market_data_interface``：``_call_interface_raw`` 与单接口试调。

⚠️ **本门面严禁 re-export** ``_get_shared_http_client``（及同属 fetch 的
``_apply_code_prefix`` / ``_is_placeholder_param_value``）：测试以
``import app.services.market_data_fetch as mds; mds.X = ...`` 的**模块属性赋值**方式
monkeypatch，若本门面保留同名字号，patch 只改本模块命名空间，运行期读的仍是
``market_data_fetch`` 命名空间里的真函数 —— 测试**照绿但逻辑从未被覆盖**（静默失效）。
守卫见 ``tests/test_market_data_patch_targets.py``。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

# ── 参数与规范化（market_data_params）：本门面 re-export，供既有 import 点零改动 ──
from app.services.market_data_params import (
    CHAIN_BUDGET as CHAIN_BUDGET,
    DEFAULT_TIMEOUT as DEFAULT_TIMEOUT,
    DIVIDEND_LIST_CAT_ID as DIVIDEND_LIST_CAT_ID,
    FAILURE_THRESHOLD as FAILURE_THRESHOLD,
    MASTER_LIST_CAT_ID as MASTER_LIST_CAT_ID,
    NOTICE_CAT_ID as NOTICE_CAT_ID,
    QUOTE_CAT_ID as QUOTE_CAT_ID,
    RETRY_BACKOFF_BASE as RETRY_BACKOFF_BASE,
    RETRY_BACKOFF_CAP as RETRY_BACKOFF_CAP,
    SECURITY_MASTER_NAMESPACE as SECURITY_MASTER_NAMESPACE,
    FetchResult as FetchResult,
    _URL_LENGTH_WARN_THRESHOLD as _URL_LENGTH_WARN_THRESHOLD,
    _infer_cn_exchange as _infer_cn_exchange,
    _infer_exchange as _infer_exchange,
    _norm_exchange as _norm_exchange,
    _normalize_master_code as _normalize_master_code,
    _parse_rate_limit as _parse_rate_limit,
    _row_get as _row_get,
    infer_exchange as infer_exchange,
    master_id_for as master_id_for,
)

# ── 抓取与归一化（market_data_fetch）：本门面 re-export，供既有 import 点零改动 ──
# ⚠️ 严禁 re-export ``_get_shared_http_client``（测试以模块属性赋值方式 monkeypatch）：
#    re-export 会让 patch 打在门面命名空间、运行期仍读 fetch 的真函数 → 测试假绿。
from app.services.market_data_fetch import (
    MarketDataFetchMixin,
    _RATE_LIMITER as _RATE_LIMITER,
    _flatten_dataframe_records as _flatten_dataframe_records,
)

# ── 价格链路（market_data_price）──
from app.services.market_data_price import MarketDataPriceMixin

# ── 主数据同步（market_data_master）──
from app.services.market_data_master import (
    SecurityMasterSyncMixin,
    _compute_pinyin_initials as _compute_pinyin_initials,
)

# ── 主数据自愈（market_data_master_heal）──
from app.services.market_data_master_heal import SecurityMasterHealMixin

# ── raw 分派与单接口试调（market_data_interface）──
from app.services.market_data_interface import MarketDataInterfaceMixin


class MarketDataSyncService(
    MarketDataPriceMixin,
    MarketDataFetchMixin,
    MarketDataInterfaceMixin,
    SecurityMasterSyncMixin,
    SecurityMasterHealMixin,
):
    """实时行情 / 证券主数据同步服务（mixin 组装，行为与拆分前逐行等价）。

    各 mixin 方法名互不重叠，故 MRO 顺序不影响解析；``self._mark_success`` /
    ``self._fetch_https_raw`` 等跨 mixin 调用经本类统一解析。
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        # 最近一次 HTTPS 调用的上游状态码（测试端点回传用；SDK 接口为 None）
        self._last_http_status: Optional[int] = None
