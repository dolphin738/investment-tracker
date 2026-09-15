"""行情「抓取与归一化」mixin：限流、共享 HTTP 客户端、HTTPS / SDK 原始抓取。

自 ``market_data_sync`` 按位置拆分而来（ADR-002 / 架构治理 §4）：承载所有**真实 IO 原语**
（HTTP 连接池、SDK 懒导入调用）与响应归一化（JSON / 文本分隔 / DataFrame）。

⚠️ **本模块持有 monkeypatch 靶点 ``_get_shared_http_client``**：测试以
``import app.services.market_data_fetch as mds; mds._get_shared_http_client = ...``
替换之。故**门面 ``market_data_sync`` 严禁 re-export 该函数** —— 否则 patch 打在门面命名
空间、运行期读的仍是本模块的真函数，测试**假绿**。守卫见
``tests/test_market_data_patch_targets.py``。

依赖方向：``market_data_params ← 本模块``；本模块不得 import 门面（循环导入）。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, Optional

import httpx

from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.market_data_params import (
    DEFAULT_TIMEOUT,
    RETRY_BACKOFF_BASE,
    RETRY_BACKOFF_CAP,
    _URL_LENGTH_WARN_THRESHOLD,
    _infer_cn_exchange,
    _parse_rate_limit,
)

logger = logging.getLogger(__name__)

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

# JSON/FastAPI 唯一可序列化的 key 类型（str/int/float/bool/None）——与 json.dumps 一致。
# tuple 等复合类型会在序列化时抛 ``TypeError: keys must be str, int, float, bool or
# None, not tuple``，且发生在**很晚**（响应序列化阶段），错误不可读。
_JSON_SCALAR_KEY_TYPES = (str, int, float, bool, type(None))


def _flatten_dataframe_records(df: Any) -> list[dict]:
    """DataFrame → ``list[dict]``（列名成为顶层 key），并**显式拒绝非标量列名**。

    方案 §8 边界 4：MultiIndex 列经 ``to_dict("records")`` 会产出 tuple key，一路透传到
    ``json.dumps`` 才以 ``TypeError`` 暴露，不可读。此处拍平时即检测：出现 json 不可
    序列化的 key（tuple 等）→ 抛**带可读中文说明**的异常，明确「MultiIndex 多层表头
    不支持、请先展平列名后重试」。**绝不静默展平**（静默展平会掩盖列结构问题，与边界 5
    「宁可错得明显」一致）。

    对非 MultiIndex（列名为 str / int 等标量）场景**零行为影响**：与旧 ``to_dict`` 结果一致。
    """
    records = [dict(r) for r in df.to_dict("records")]
    for record in records:
        for key in record:
            if not isinstance(key, _JSON_SCALAR_KEY_TYPES):
                raise ValueError(
                    "SDK 返回的 DataFrame 含非标量列名（疑似 MultiIndex 多层表头），"
                    "当前不支持：请先将列名展平为单层字符串后重试"
                    f"（实际列名示例：{key!r}）。"
                )
    return records


# 进程内共享 HTTP 连接池：行情请求（含重试）复用 TCP 连接，避免每次新建
# AsyncClient 重新握手。连接池绑定创建时的事件循环（anyio 要求），跨循环
# 时重建——测试环境每用例新建 loop 也能安全复用各自连接。
_shared_http_client: Optional[httpx.AsyncClient] = None
_shared_http_client_loop: Optional[asyncio.AbstractEventLoop] = None


def _get_shared_http_client() -> httpx.AsyncClient:
    """返回绑定当前事件循环的共享 AsyncClient（连接池复用）。"""
    global _shared_http_client, _shared_http_client_loop
    loop = asyncio.get_running_loop()
    if _shared_http_client is None or _shared_http_client_loop is not loop:
        _shared_http_client = httpx.AsyncClient()
        _shared_http_client_loop = loop
    return _shared_http_client


class MarketDataFetchMixin:
    """抓取与归一化：限流包装、HTTPS / SDK 原始抓取、响应归一化。

    方法体由 ``market_data_sync.MarketDataSyncService`` 原位置迁来，类内调用点
    （``self._normalize_rows(...)`` / ``self._guarded_fetch(...)`` 等）零改动。
    """

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
            # 批量拼接长度防护：仅告警、不改请求形态（见 _URL_LENGTH_WARN_THRESHOLD）。
            # 内联形态 URL 直接膨胀；非内联形态 URL 不变但查询串膨胀，故按 URL + 代码串合计计。
            effective_len = len(url) + (0 if inline else len(joined))
            if effective_len > _URL_LENGTH_WARN_THRESHOLD:
                logger.warning(
                    "HTTPS 请求行过长（当前约 %d 字符，阈值 %d；代码 %d 只）："
                    "疑似 response_parse.max_codes_per_request 被调到远超当前量级"
                    "（正常 800 只约 7221 字符），请核对配置",
                    effective_len,
                    _URL_LENGTH_WARN_THRESHOLD,
                    len(codes),
                )
        else:
            url = base_url.rstrip("/") + "/" + itf.endpoint.lstrip("/")
        timeout = clamp_timeout(itf.timeout or DEFAULT_TIMEOUT)

        async def _do() -> list[dict]:
            client = _get_shared_http_client()
            resp = await client.request(
                itf.http_method or "GET", url, params=params, timeout=timeout
            )
            self._last_http_status = resp.status_code
            if resp.status_code >= 500:
                raise RuntimeError(f"上游 5xx: {resp.status_code}")
            if resp.status_code in (401, 403):
                raise RuntimeError(f"鉴权失败: {resp.status_code}")
            resp.raise_for_status()
            if (rp.get("format") or "json").lower() == "text_split":
                # 非 JSON 文本（如腾讯财经 ~ 分隔 + gbk 编码）：按 response_parse 解析。
                # 正则回放属重 CPU（admin 可自由配置 line_regex），丢线程池避免
                # 阻塞事件循环（ReDoS 时仅占用单线程而非整个服务）。
                enc = rp.get("encoding") or "utf-8"
                resp.encoding = enc
                return await asyncio.to_thread(self._parse_text_split, resp.text, rp)
            return self._normalize_rows(resp.json())

        return await self._guarded_fetch(itf, _do)

    @staticmethod
    def _parse_text_split(text: str, rp: dict) -> list[dict]:
        """文本分隔响应 → 行列表（dict 行：键为字符串下标 + 可选 ``_code`` 前缀代码）。

        覆盖腾讯财经等 ``~`` 分隔纯文本接口（非 JSON）。行提取正则 ``line_regex``：

        - 2 个捕获组（如 ``v_(\\w+)="([^"]*)"``）：group1=变量名中的带前缀代码
          （如 ``sz000001``），group2=引号内内容 → 拆 ``sep`` 后每行注入 ``_code``，
          便于直接归一化（含市场前缀，美股等也不会丢前缀）。
        - 1 个捕获组：仅内容，代码回退到 ``fields[idx]``（code 槽 source 配下标）。
        - 无正则：整段按 ``sep`` 拆成单行（兜底）。

        批量响应（``v_aa="...";v_bb="..."``）用 ``re.finditer`` 逐段提取；``[^"]*``
        保证不跨段贪婪合并。
        """
        sep = rp.get("sep", "~")
        line_regex = rp.get("line_regex")
        rows: list[dict] = []
        # 响应体长度钳制：超大体量文本先截断，限制正则回放的 CPU 上界
        text = text[:5_000_000]
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
                return _flatten_dataframe_records(df)
            if hasattr(df, "iterrows"):  # 兼容非 pandas DataFrame 替身（测试）
                return [
                    (r.to_dict() if hasattr(r, "to_dict") else dict(r))
                    for _, r in df.iterrows()
                ]
            return []

        return await self._guarded_fetch(itf, _do)
