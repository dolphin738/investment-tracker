"""行情同步「参数与规范化」基座（纯逻辑、零 IO）。

自 ``market_data_sync`` 按位置拆分而来（ADR-002 / 架构治理 §4）：本模块只承载
**无 IO 原语** —— 常量、交易所/代码规范化、参数占位符与速率解析、主数据 id 派生，
供以下兄弟模块单向依赖：

- ``market_data_fetch``：限流 / HTTP 抓取 / 文本与 DataFrame 归一化；
- ``market_data_price``：分类选源 fallback 链与价格解析；
- ``market_data_master`` / ``market_data_master_heal``：主数据同步与自愈；
- ``market_data_interface``：raw 分派与单接口试调。

⚠️ 依赖方向固定为 ``params ← 各兄弟模块 ← 门面 market_data_sync``，
**任何兄弟模块都不得反向 import 门面**（会形成循环导入）。
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

from app.models.enums import SecurityType
from app.services.classification import (
    EXCHANGE_PREFIX,
    infer_exchange,
    infer_exchange_prefix,
)
from app.services.response_path import row_get as _core_row_get

logger = logging.getLogger(__name__)

# 交易所推断规则统一收敛到 app.services.classification（单一事实来源）。
# 以下别名仅用于兼容内部调用命名与既有测试，规则逻辑不再在此处维护。
# 注意：infer_exchange_prefix 对 5 位纯数字返回 "hk"（与 _apply_code_prefix 的
# 港股分支一致），旧 _infer_cn_exchange 对 5 位码按首位判定已不再使用。
_infer_exchange = infer_exchange
_infer_cn_exchange = infer_exchange_prefix

# —— 可配置阈值（ADR-002 §3 Q4 默认 3）——
FAILURE_THRESHOLD: int = 3
# 单接口默认超时（秒）
DEFAULT_TIMEOUT: int = 5
# 单链总超时预算（秒，ADR-002 §2.3 封顶 ≤8s）
CHAIN_BUDGET: int = 8
# 重试退避基数与上限（秒）— 指数退避：base * 2^attempt，封顶 cap
RETRY_BACKOFF_BASE: float = 0.5
RETRY_BACKOFF_CAP: float = 5.0

# HTTPS 请求「长度」告警阈值（字符）。**仅用于捕捉「配置被改到远超当前量级」的极端情形**，
# 并非「长度本身会致故障」——实测正常日抓 800 只内联 URL = **7221 字符**仍 HTTP 200（395KB /
# 436ms），长度问题已证伪。取 8192（>7221 留余量）：正常批量**不误报**；只有把
# ``max_codes_per_request`` 提到约 1000+ 只（URL ≈ 9000+）时才告警。不改请求形态——分片会
# 牵动 ``max_codes_per_request`` 语义与大量既有测试，另行评估。
_URL_LENGTH_WARN_THRESHOLD: int = 8192

# 固定接口分类 id（接口分类改版：分类即用途，见 plan-interface-category-reform-2026-08-15）。
# 与迁移 o3d4e5f6a7b8_reform_2_categories 中 INSERT 的显式 id 保持一致；路由按此硬编码选源。
# 列是 String(36)（非 PG 原生 UUID 类型），故用简短数字 id，不依赖 gen_random_uuid()。
MASTER_LIST_CAT_ID = "1"  # 证券列表（主数据拉取）
QUOTE_CAT_ID = "2"        # 证券行情（价格行情）
DIVIDEND_LIST_CAT_ID = "3"  # 股息列表（分红事件：分红明细源）
NOTICE_CAT_ID = "4"        # 公司公告（公告扫描：特别分红补充）


def _parse_rate_limit(value: Optional[str]) -> Optional[float]:
    """解析 ``rate_limit`` 自由文本为「最小请求间隔（秒）」。

    支持 ``N/min``、``N/sec``、``N/hour``（及 s/m/h 缩写）。解析失败返回 None（不限流）。
    """
    if not value:
        return None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*/\s*(min|sec|hour|m|s|h)\s*$", value, re.IGNORECASE)
    if not m:
        return None
    n = float(m.group(1))
    if n <= 0:
        return None
    unit = m.group(2).lower()
    per = {"sec": 1, "s": 1, "min": 60, "m": 60, "hour": 3600, "h": 3600}[unit]
    return per / n


@dataclass
class FetchResult:
    """一次分类级 fallback 的结果。"""

    prices: dict[str, Decimal]
    source: Optional[str]


def _norm_exchange(ex: Optional[str]) -> Optional[str]:
    """把源返回的交易所字符串规范到枚举值 SH/SZ/BJ/HK（兼容中文/大小写/代码）。

    源响应里的交易所可能形如 ``"SH"`` / ``"sz"`` / ``"上海"`` / ``".SZ"`` / ``"XHKG"`` 等，
    统一归一为 SH/SZ/BJ/HK 便于 ``EXCHANGE_PREFIX`` 拼前缀 + 存储一致。
    """
    if not ex:
        return None
    e = str(ex).strip().upper()
    mapping = {
        "SH": "SH", "SSE": "SH", "SHANGHAI": "SH", "上交所": "SH", "上海": "SH",
        "SZ": "SZ", "SZSE": "SZ", "SHENZHEN": "SZ", "深交所": "SZ", "深圳": "SZ",
        "BJ": "BJ", "BSE": "BJ", "北交所": "BJ", "北京": "BJ",
        "HK": "HK", "HKE": "HK", "XHKG": "HK", "港股": "HK",
    }
    return mapping.get(e)


# --------------------------------------------------------------------------- #
# 证券主数据确定性 id（业务自然键 (asset_class, code) → uuid5 确定性派生）
# --------------------------------------------------------------------------- #
# 固定命名空间（写入代码即锁死，不可更改，否则全部 id 重算）
SECURITY_MASTER_NAMESPACE = uuid.UUID("b3f7e0c2-1a4d-4e9b-9c2a-000000000001")


def master_id_for(asset_class: "SecurityType | None", code: str) -> str:
    """由业务自然键 ``(asset_class, code)`` 确定性派生 ``securities.id``。

    关键性质：相同 ``(asset_class, code)`` 永远得到同一 36 字符 UUID 字符串；
    证券被删除后重新同步（再次走 ``_upsert_masters`` 同参）将得到与删除前完全相同的
    id，保证 ``portfolio_securities.master_id`` 外键引用稳定、可重建。

    - ``asset_class`` 为 ``SecurityType`` 枚举，必须用 ``.value``（如 ``"STOCK"``），
      不得用 ``str(枚举)``（会得到 ``"SecurityType.STOCK"`` 这类错误键）。
    - ``asset_class`` 为 ``None`` 时用哨兵 ``"NULL"``，与 ``_upsert_masters`` 的查重键
      ``(asset_class, code)`` 完全一致，保证幂等。
    """
    ac = asset_class.value if asset_class is not None else "NULL"  # 哨兵
    return str(uuid.uuid5(SECURITY_MASTER_NAMESPACE, f"{ac}|{code}"))


def _normalize_master_code(raw: str, exchange: Optional[str] = None) -> str:
    """主数据代码统一为「交易所前缀 + 纯数字」（保留前导零），如 sh600000 / sz000001 / bj920021 / hk00700。

    不同数据源代码格式不一（``"600000"`` / ``"600000.SH"`` / ``"sh600000"`` / ``"00700.HK"``）
    统一规范为带交易所前缀的数字串，供 ``(asset_class, code)`` 唯一约束去重 + 前端带前缀展示：

    - 显式前缀（``sh/sz/bj/hk``）或后缀（``.SH/.SZ/.HK/.BJ``）→ 直接取下划线前的交易所 + 数字
    - 纯数字无交易所信息 → 用 ``exchange`` 参数或数字启发式推断前缀（``infer_exchange``）

    例：``sh600000``→``sh600000``，``600000.SH``→``sh600000``，``000001.SZ``→``sz000001``，
    ``00700.HK``→``hk00700``，``600000``（无交易所）→``sh600000``（数字推断上交所）。

    关键点：带前缀后 ``sz000012``（南玻A）与 ``sh000012``（国债指数）天然区分，
    不会像纯数字 ``000012`` 那样跨市场误合并；同时代码自带交易所，前端无需单列「市场」。
    无数字可提取时回退原始串（如纯字母代码），不丢数据。
    """
    if not raw:
        return raw
    s = str(raw).strip()
    # 1. 显式前缀 sh/sz/bj/hk
    m = re.match(r"^(sh|sz|bj|hk)(\d+)", s, re.IGNORECASE)
    if m:
        return f"{m.group(1).lower()}{m.group(2)}"
    # 2. 交易所后缀 .SH/.SZ/.HK/.BJ（及其小写）
    m = re.match(r"^(\d+)\.(sh|sz|bj|hk)$", s, re.IGNORECASE)
    if m:
        return f"{m.group(2).lower()}{m.group(1)}"
    # 3. 纯数字：用 exchange 或数字启发式推断前缀
    digits = re.sub(r"\D", "", s)
    if not digits:
        return s
    ex = _norm_exchange(exchange) or infer_exchange(digits)
    prefix = EXCHANGE_PREFIX.get(ex or "", "")
    return f"{prefix}{digits}"


def _row_get(row: Any, field: Optional[str]) -> Any:
    """从行取值（唯一收口，向后兼容）。

    - dict 行：按字段名 / 路径取值（新增 ``a.b`` / ``items[0].code`` / ``a\\.b`` 字面含点 key）；
    - 数组行：``field`` 为纯数字时按位置下标（小熊同学 /stock/all 的 ``[[code,name],...]``）；
    - 歧义由显式 ``[N]`` / ``\\.`` 消除，不做「先试路径再试字面 key」的静默双策略（方案边界 1）；
    - dict 行字面 key ``"0"`` 与数组行下标 ``0`` 语义保持现状（方案边界 2）。

    实现下沉到 ``app.services.response_path.row_get``（纯逻辑、可穷举单测）。
    """
    return _core_row_get(row, field)
