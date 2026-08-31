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

import asyncio
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import httpx
import pypinyin
from pypinyin import Style
from sqlalchemy import delete as sa_delete
from sqlalchemy import exists as sa_exists
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.date_utils import today_app_tz
from app.models.enums import SecurityType
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import PortfolioSecurity, Security, SecurityPrice
from app.services.notification import NotificationService
from app.services.recalculation import RecalculationService
from app.services.classification import (
    EXCHANGE_PREFIX,
    classify_security,
    infer_exchange,
    infer_exchange_prefix,
    is_dropped,
)
from app.services.security import infer_security_type

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

# 固定接口分类 id（接口分类改版：分类即用途，见 plan-interface-category-reform-2026-08-15）。
# 与迁移 o3d4e5f6a7b8_reform_2_categories 中 INSERT 的显式 id 保持一致；路由按此硬编码选源。
# 列是 String(36)（非 PG 原生 UUID 类型），故用简短数字 id，不依赖 gen_random_uuid()。
MASTER_LIST_CAT_ID = "1"  # 证券列表（主数据拉取）
QUOTE_CAT_ID = "2"        # 证券行情（价格行情）

# 参数占位符（接口模板里常见的示例值，如 string / 示例 / example）。
# 这些值并非真实业务参数，发出去会导致上游按占位符过滤（如小熊同学 keyWord=string 返回空列表），
# 故在构建请求时与空值一并忽略。集合刻意保持极小，避免误伤真实参数。
_PLACEHOLDER_PARAM_VALUES = {"string", "示例", "example", "占位", "占位符", "placeholder", "xxx"}


def _is_placeholder_param_value(v: Any) -> bool:
    """参数值是否为模板占位符（不应作为真实查询参数发送）。"""
    if isinstance(v, str):
        return v.strip().lower() in _PLACEHOLDER_PARAM_VALUES
    return False


def _apply_code_prefix(code: str, mode: Optional[str]) -> str:
    """按 ``code_prefix`` 模式补全代码前缀。

    ``"auto"``（位数感知，单接口覆盖 A股/场内基金/港股，腾讯/新浪风格）：
    - **5 位纯数字** → 补 ``hk``（港股恒为 5 位，如 ``00700`` → ``hk00700``）；
    - **6 位纯数字** → 按首位推断 sh/sz/bj（A股/场内基金风格，如 ``600519`` → ``sh600519``、
      ``000001`` → ``sz000001``、``510300`` → ``sh510300``）；
    - **已带前缀**（如 ``sh600519`` / ``hk00700``）或**非数字**（如 ``AAPL``）→ 原样返回，
      绝不重复加字母。

    其他 / 空：原样返回。
    """
    if mode != "auto" or not code or not code.isdigit():
        return code
    if len(code) == 5:
        return "hk" + code
    if len(code) == 6:
        ex = _infer_cn_exchange(code)
        if ex:
            return ex + code
    return code


class _InterfaceRateLimiter:
    """按接口维度的固定间隔限流器，落实 ``rate_limit`` 字段。

    键为接口 id；``acquire`` 保证同一接口两次「实际请求」之间至少间隔 ``interval`` 秒。
    实例跨协程/跨请求共享（模块级单例），避免批量同步中单接口被瞬时打爆。
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._next_allowed: dict[str, float] = {}

    def _lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def acquire(self, interface_id: str, interval: float) -> None:
        if interval is None or interval <= 0:
            return
        async with self._lock(interface_id):
            now = time.monotonic()
            nxt = self._next_allowed.get(interface_id, 0.0)
            if now < nxt:
                await asyncio.sleep(nxt - now)
            self._next_allowed[interface_id] = time.monotonic() + interval


# 模块级单例：覆盖全部接口调用路径（HTTPS / SDK / 测试面板）
_RATE_LIMITER = _InterfaceRateLimiter()


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

    async def _guarded_fetch(
        self, itf: QuoteInterface, do_fetch: Callable[[], Awaitable[Any]]
    ) -> Any:
        """统一的「频率限制 + 重试」包装，覆盖所有接口调用路径。

        - 频率限制：按 ``itf.rate_limit`` 解析的间隔做固定间隔节流（仅当配置了 rate_limit）。
        - 重试：最多 ``1 + (retry_count or 0)`` 次；配置类错误（ValueError，如缺 base_url /
          函数不存在）不重试直接抛出；其余异常按指数退避重试。
        """
        interval = _parse_rate_limit(itf.rate_limit)
        if interval is not None:
            await _RATE_LIMITER.acquire(itf.id, interval)
        max_attempts = 1 + max(0, itf.retry_count or 0)
        last_exc: Optional[BaseException] = None
        for attempt in range(max_attempts):
            try:
                return await do_fetch()
            except ValueError:
                # 配置/参数错误，重试无意义
                raise
            except Exception as exc:  # noqa: BLE001  其余异常按退避重试
                last_exc = exc
                if attempt < max_attempts - 1:
                    backoff = min(RETRY_BACKOFF_BASE * (2 ** attempt), RETRY_BACKOFF_CAP)
                    await asyncio.sleep(backoff)
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("接口请求重试耗尽但未捕获异常")

    async def _fetch_https_raw(
        self, itf: QuoteInterface, params: Optional[dict[str, Any]], codes: Optional[list[str]]
    ) -> list[dict]:
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        config = (provider.config or {}) if provider is not None else {}
        base_url = config.get("base_url")
        if not base_url or not itf.endpoint:
            raise ValueError("HTTPS 接口缺少 base_url 或 endpoint")
        # SSRF 防护：provider base_url 仅允许 http/https（私网/环回放开，内部源常见）
        from app.core.url_guard import assert_safe_url, clamp_timeout

        assert_safe_url(base_url, allow_private=True)
        rp = itf.response_parse or {}
        # 参数传递：值为空（None / "" / 空列表）或模板占位符（如 string / 示例）直接忽略，
        # 不进入请求——避免 ?key= 这类无效参数，以及占位符把上游过滤成空列表
        # （如小熊同学 keyWord=string 返回 data:[]）。
        params = {
            k: (",".join(v) if isinstance(v, list) else v)
            for k, v in (params or {}).items()
            if v not in (None, "", [])
            and not _is_placeholder_param_value(v)
        }
        # 代码参数名（默认 code）；endpoint 以 "=" 结尾时直接拼到路径
        # （腾讯财经 q= 内联形态：qt.gtimg.cn/q=sh600519）。
        code_param = rp.get("code_param")
        inline = itf.endpoint.endswith("=")
        if codes is not None:
            # code_prefix=auto：纯数字代码按交易所推断补 sh/sz/bj 前缀（腾讯/新浪风格）；
            # 已带前缀或非数字代码原样保留，绝不重复加字母。
            prefix_mode = rp.get("code_prefix")
            if prefix_mode:
                codes = [_apply_code_prefix(c, prefix_mode) for c in codes]
            joined = ",".join(codes)
            if inline:
                url = base_url.rstrip("/") + "/" + itf.endpoint.lstrip("/") + joined
            else:
                params[code_param or "code"] = joined
                url = base_url.rstrip("/") + "/" + itf.endpoint.lstrip("/")
        else:
            url = base_url.rstrip("/") + "/" + itf.endpoint.lstrip("/")
        timeout = clamp_timeout(itf.timeout or DEFAULT_TIMEOUT)

        async def _do() -> list[dict]:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.request(itf.http_method or "GET", url, params=params)
            self._last_http_status = resp.status_code
            if resp.status_code >= 500:
                raise RuntimeError(f"上游 5xx: {resp.status_code}")
            if resp.status_code in (401, 403):
                raise RuntimeError(f"鉴权失败: {resp.status_code}")
            resp.raise_for_status()
            if (rp.get("format") or "json").lower() == "text_split":
                # 非 JSON 文本（如腾讯财经 ~ 分隔 + gbk 编码）：按 response_parse 解析
                enc = rp.get("encoding") or "utf-8"
                resp.encoding = enc
                return self._parse_text_split(resp.text, rp)
            return self._normalize_rows(resp.json())

        return await self._guarded_fetch(itf, _do)

    @staticmethod
    def _parse_text_split(text: str, rp: dict) -> list[dict]:
        """文本分隔响应 → 行列表（dict 行：键为字符串下标 + 可选 ``_code`` 前缀代码）。

        覆盖腾讯财经等 ``~`` 分隔纯文本接口（非 JSON）。行提取正则 ``line_regex``：

        - 2 个捕获组（如 ``v_(\\w+)="([^"]*)"``）：group1=变量名中的带前缀代码
          （如 ``sz000001``），group2=引号内内容 → 拆 ``sep`` 后每行注入 ``_code``，
          便于直接归一化（含市场前缀，美股等也不会丢前缀）。
        - 1 个捕获组：仅内容，代码回退到 ``fields[idx]``（``resp_code_field`` 配下标）。
        - 无正则：整段按 ``sep`` 拆成单行（兜底）。

        批量响应（``v_aa="...";v_bb="..."``）用 ``re.finditer`` 逐段提取；``[^"]*``
        保证不跨段贪婪合并。
        """
        sep = rp.get("sep", "~")
        line_regex = rp.get("line_regex")
        rows: list[dict] = []
        if not line_regex:
            fields = text.split(sep)
            rows.append({str(i): v for i, v in enumerate(fields)})
            return rows
        for m in re.finditer(line_regex, text, re.DOTALL):
            ng = m.lastindex or 0
            if ng >= 2:
                code = m.group(1)
                content = m.group(2)
            elif ng == 1:
                code = None
                content = m.group(1)
            else:
                continue
            fields = content.split(sep)
            row: dict[str, Any] = {str(i): v for i, v in enumerate(fields)}
            if code is not None:
                row["_code"] = code
            rows.append(row)
        return rows

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
        # SDK 同步阻塞调用：放入线程并施加超时，避免阻塞事件循环且无超时保护。
        # 仅当显式配置 timeout 才生效；未配置沿用历史无超时行为，避免破坏慢接口。
        timeout = itf.timeout
        params = {**(params or {})}
        if codes:
            # codes 非空时透传（如 stock_zh_a_spot 按 code 入参）
            params = {**params, "codes": codes}

        async def _do() -> list[dict]:
            # 懒导入：模块级不 import akshare（见文件头约束）
            import akshare  # noqa: PLC0415

            func = getattr(akshare, sdk_func, None)
            if func is None:
                raise ValueError(f"akshare 中不存在函数 {sdk_func}")
            df = await asyncio.wait_for(
                asyncio.to_thread(func, **params), timeout=timeout
            )
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

        return await self._guarded_fetch(itf, _do)

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
                # 价格 code 同样规范为「交易所前缀 + 数字」，与主数据对齐（否则带后缀源匹配不到）
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
            # 测试端点解析同样规范为「交易所前缀 + 数字」，与同步/价格口径一致
            out[_normalize_master_code(str(code))] = str(price)
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

        # 行情同步仅查「证券行情」固定分类（分类即用途，见 reform 方案）；
        # 顺带修掉旧实现"主数据分类也被当行情源"的潜在 bug。
        synced = 0
        failed = 0
        errors: list[str] = []
        result = await self.fallback_fetch(QUOTE_CAT_ID, codes)
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

    async def _normalize_and_dedupe_masters(self) -> int:
        """扫描系统主数据并自愈：

        1) 逐行从**数字码**重推交易所 / 资产类别 / 规范码（``infer_security_type`` +
           ``_infer_exchange``），忽略已存错的 ``exchange``（避免错标被继承），修正历史错位：
           - 北京主板 ``920xxx`` 曾被误判 SH → 归 BJ
           - 港股 5 位码（``80016``/``02318``…）曾被 head 规则误归 BJ/SZ → 归 HK
           - 可转债 ``11xxxx``/``12xxxx``、深市基金 ``15/16xxxx`` 曾漏交易所前缀
             （``_infer_exchange`` 无对应分支返回 None）→ 补 SH/SZ 前缀
        2) 按 ``(asset_class, 规范code)`` 合并重复行（不同源带/不带交易所字母导致的历史重复）。
        3) 对保留行按新自然键 ``(asset_class, code)`` 重算派生 id 并迁移
           ``portfolio_securities`` 引用（见 ``_reassign_master_id``），消除「code 已自愈、
           id 仍是旧键派生」的历史错位——否则下次同步按新 code 查重未命中、按新 id
           INSERT 会撞上旧 id 记录，触发 ``securities_pkey`` 唯一约束冲突。

        顺序：先在内存完成「重推断 + 分组」，再删除重复行，最后统一 ``flush``——
        避免两行在重推断后短暂撞 ``(asset_class, code)`` 唯一约束。

        合并规则：按 ``(asset_class, 规范code)`` 分组，保留 ``updated_at`` 最新行，其余删除；
        删除前把其 ``portfolio_securities`` 引用安全转移到保留行（保留行已在该组合持有同一标的
        → 属重复持仓，直接丢弃该残留引用），避免误删用户持仓。
        （securities 现为纯目录表，无 portfolio_id 列，故直接全表扫描。）
        """
        rows = (
            await self.session.execute(select(Security))
        ).scalars().all()

        # 0) 丢弃类别（按 fund-classification-rules.md）：老三板/全国股转(4xxxxx)、
        #    北交所旧段(8xxxxx) 不写入 securities 主数据表，自愈时直接物理删除，
        #    确保这些类别在表中物理不存在（含名称含「退债」的退市可转债，落 4xxxxx
        #    段一律丢弃，不作例外）。
        dropped_securities: list[Security] = []
        normal_rows: list[Security] = []
        for s in rows:
            digits = re.sub(r"\D", "", s.code or "")
            if digits and is_dropped(digits, s.name or ""):
                dropped_securities.append(s)
            else:
                normal_rows.append(s)

        # 1) 逐行从数字码重推「交易所 / 资产类别 / 规范码」目标值（忽略已存错的 exchange，
        #    以免错标被继承）。仅计算、暂不改写，避免两行重推断后短暂撞唯一约束。
        targets: dict[Security, tuple[str, Optional[str], Any]] = {}
        for s in normal_rows:
            digits = re.sub(r"\D", "", s.code or "")
            if not digits:
                continue
            ex = infer_exchange(digits)
            code = _normalize_master_code(digits, ex)
            # 传名称：混合段场内基金需靠 ETF/LOF/REIT/封闭 等名称标记判定场内
            ac = infer_security_type(code, ex, s.name or "")
            # 指数前缀修正：000xxx 上证指数强制 sh、399xxx 深证指数强制 sz，
            # 自愈历史误存（如 sz000012 国债指数）为 sh000012
            if ac == SecurityType.INDEX:
                ex = classify_security(code, s.name or "").get("exchange") or ex
                code = f"{EXCHANGE_PREFIX.get(ex or '', '')}{digits}"
            targets[s] = (code, ex, ac)

        # 2) 按目标 (asset_class, 规范code) 分组
        groups: dict[tuple, list[Security]] = {}
        for s, t in targets.items():
            groups.setdefault(t, []).append(s)

        # 整个方法在 no_autoflush 下进行：重推断的待定改动不会在删除 dup 前被提前 flush 触发
        removed = 0
        ps_alias = aliased(PortfolioSecurity)
        with self.session.no_autoflush:
            for (code, ex, ac), items in groups.items():
                if len(items) == 1:
                    s = items[0]
                    s.code, s.exchange, s.asset_class = code, ex, ac
                    await self._reassign_master_id(s)
                    await self.session.flush()  # 单行无撞键风险
                    continue
                items.sort(key=lambda x: (x.updated_at or datetime.min), reverse=True)
                keep = items[0]
                # 先安全转移并删除重复行；此时 keep 仍保留旧 code，无撞键风险
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
                await self.session.flush()  # 先落库删掉 dup
                # 再对保留行应用重推断结果（此时 dup 已删，无撞键风险）
                keep.code, keep.exchange, keep.asset_class = code, ex, ac
                await self._reassign_master_id(keep)
                await self.session.flush()
                removed += len(items) - 1

        # 3) 物理删除丢弃类别行：先清除其 portfolio_securities 引用，避免悬空外键，
        #    再删除主数据行，确保老三板/全国股转(4xxxxx)、北交所旧段(8xxxxx) 不在表中。
        if dropped_securities:
            for s in dropped_securities:
                await self.session.execute(
                    sa_delete(PortfolioSecurity).where(
                        PortfolioSecurity.master_id == s.id
                    )
                )
                await self.session.delete(s)
                removed += 1
            await self.session.flush()

        return removed

    async def _reassign_master_id(self, s: Security) -> None:
        """重算并迁移 ``securities.id``：当自愈把某行的 code/asset_class 重推后，
        旧派生 id 不再等于 ``master_id_for(asset_class, code)`` 时，按新自然键重派生 id，
        并同步迁移 ``portfolio_securities.master_id`` 外键引用，保证 id 与
        ``(asset_class, code)`` 永远一致（否则下次同步按新 code 查重未命中、按新 id
        INSERT 会撞上旧 id 记录，触发 ``securities_pkey`` 唯一约束冲突）。

        依赖 ``master_id_for`` 的确定性：同一 ``(asset_class, code)`` 恒得同一 UUID，
        不同自然键的 id 必不相同，故新 id 正常情况下不会被其他行占用（撞键时跳过，
        由后续合并去重兜底）。
        """
        new_id = master_id_for(s.asset_class, s.code)
        if new_id == s.id:
            return
        clash = (
            await self.session.execute(
                select(Security.id).where(
                    Security.id == new_id,
                    Security.id != s.id,
                )
            )
        ).scalar_one_or_none()
        if clash:
            return
        # master_id 外键为 DEFERRABLE INITIALLY DEFERRED：先迁移持仓引用、再改 securities.id，
        # FK 检查推迟到事务提交，彼时两行已一致，不会因「改主键时子表仍引用旧 id」而报违例。
        # 注：本方法在 no_autoflush 上下文内调用，flush 不提前触发约束检查。
        await self.session.execute(
            update(PortfolioSecurity)
            .where(PortfolioSecurity.master_id == s.id)
            .values(master_id=new_id)
        )
        await self.session.execute(
            update(Security).where(Security.id == s.id).values(id=new_id)
        )
        s.id = new_id  # 保持 ORM 对象状态与库一致
        await self.session.flush()

    async def _upsert_masters(self, itf: QuoteInterface, rows: list[Any]) -> int:
        """把原始行 upsert 进 securities 系统主数据目录表（ADR-003 后仅主数据行）。

        行级 asset_class 由代码前缀 + 交易所**逐行推断**（infer_security_type，与组合持仓 type 同源）：
        港股经交易所识别归 HK_STOCK，无法可靠区分的类（如场外基金）落 UNCATEGORIZED；
        接口 asset_class 仅用于同步选源批次归属，不再强制打标。
        """
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
            # 丢弃类别（按 fund-classification-rules.md）：老三板/全国股转(4xxxxx)、
            # 北交所旧段(8xxxxx) 不写入 securities 主数据表，直接跳过。
            if is_dropped(raw_code, name):
                continue
            # 交易所推断须用原始 code（如 bj920021→BJ、sh600000→SH、hk00700→HK），先于归一化
            exchange = _row_get(r, exchange_field) if exchange_field else None
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
                    id=master_id_for(asset_class, code),
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
