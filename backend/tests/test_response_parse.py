"""接口级 响应解析协议（response_parse）单元测试。

覆盖 market_data_sync._parse_text_split 与 _fetch_https_raw 的：
- 文本分隔（text_split）+ gbk 解码 + 带前缀代码（_code）提取；
- 批量多段非贪婪（不跨段合并）；
- 单组正则（无前缀代码）；
- 无正则兜底（整段按 sep 拆单行）；
- 代码参数名 code_param + endpoint 以 = 结尾时内联路径（腾讯 q= 形态）。
"""
from __future__ import annotations

import httpx
import pytest
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.market_data_sync import MarketDataSyncService

pytestmark = pytest.mark.asyncio


# —— 轻量替身：模拟 httpx.AsyncClient / Response，不触网 —— #
class _FakeResp:
    def __init__(self, *, text: str | None = None, json_data: object | None = None,
                 status: int = 200) -> None:
        self.status_code = status
        self._text = text or ""
        self._json = json_data
        self.encoding: str | None = None  # _do 会按需赋 gbk/utf-8

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=self)  # type: ignore[arg-type]

    @property
    def text(self) -> str:
        return self._text

    def json(self) -> object:
        assert self._json is not None
        return self._json


class _FakeClient:
    def __init__(self, resp: _FakeResp) -> None:
        self._resp = resp
        self.last: tuple = ()

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def request(self, method: str, url: str, params=None) -> _FakeResp:
        self.last = (method, url, params)
        return self._resp


def _make_text_split_rp() -> dict:
    return {
        "format": "text_split",
        "encoding": "gbk",
        "sep": "~",
        "line_regex": r'v_(\w+)="([^"]*)"',
        "code_param": "q",
    }


def _tencent_sample() -> str:
    # 模拟腾讯财经批量响应（含中文名，编码层由 fetch 负责 gbk）
    return (
        'v_sz000001="51~平安银行~000001~15.00~14.80~15.20~...";'
        'v_hk00700="100~腾讯控股~00700~400.00~395.00~405.00~..."'
    )


# --------------------------------------------------------------------------- #
# 1) _parse_text_split 纯逻辑
# --------------------------------------------------------------------------- #
async def test_parse_text_split_two_segments_with_prefix() -> None:
    svc = MarketDataSyncService.__new__(MarketDataSyncService)
    rows = svc._parse_text_split(_tencent_sample(), _make_text_split_rp())
    assert len(rows) == 2
    assert rows[0]["_code"] == "sz000001"
    assert rows[0]["1"] == "平安银行"
    assert rows[0]["3"] == "15.00"
    assert rows[1]["_code"] == "hk00700"
    assert rows[1]["1"] == "腾讯控股"


async def test_parse_text_split_no_merge_across_segments() -> None:
    """批量响应多段必须各自独立，不能贪婪合并成一行。"""
    svc = MarketDataSyncService.__new__(MarketDataSyncService)
    rows = svc._parse_text_split(_tencent_sample(), _make_text_split_rp())
    # 每段一个 _code，绝不为 1 行
    assert sum(1 for r in rows if "_code" in r) == 2


async def test_parse_text_split_single_group_no_prefix() -> None:
    svc = MarketDataSyncService.__new__(MarketDataSyncService)
    rp = {"format": "text_split", "sep": "~", "line_regex": r'v_\w+="([^"]*)"'}
    rows = svc._parse_text_split('v_sz000001="51~平安银行~000001~15.00"', rp)
    assert len(rows) == 1
    assert "_code" not in rows[0]  # 单组正则无前缀代码
    assert rows[0]["1"] == "平安银行"


async def test_parse_text_split_no_regex_fallback() -> None:
    svc = MarketDataSyncService.__new__(MarketDataSyncService)
    rp = {"format": "text_split", "sep": "~"}
    rows = svc._parse_text_split("a~b~c", rp)
    assert len(rows) == 1
    assert rows[0] == {"0": "a", "1": "b", "2": "c"}


# --------------------------------------------------------------------------- #
# 2) _fetch_https_raw 端到端（mock httpx，验证 URL 内联 + gbk + 文本解析）
# --------------------------------------------------------------------------- #
async def test_fetch_https_inline_code_param_and_text_split(session) -> None:
    provider = SecuritiesDataProvider(
        name="腾讯财经", access_method="https", config={"base_url": "https://qt.gtimg.cn"}
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        provider_id=provider.id,
        name="腾讯实时行情",
        endpoint="q=",
        http_method="GET",
        enabled=True,
        direction="in",
        resp_code_field="_code",
        resp_price_field="3",
        response_parse=_make_text_split_rp(),
    )
    session.add(itf)
    await session.flush()

    fake = _FakeClient(_FakeResp(text=_tencent_sample()))
    import app.services.market_data_sync as mds

    original = mds.httpx.AsyncClient
    mds.httpx.AsyncClient = lambda *a, **k: fake  # type: ignore[misc,assignment]
    try:
        svc = MarketDataSyncService(session)
        rows = await svc._fetch_https_raw(itf, {}, ["sz000001", "hk00700"])
    finally:
        mds.httpx.AsyncClient = original  # type: ignore[assignment]

    # 1) URL 必须为内联形态 q=sz000001,hk00700（无 ?code=）
    method, url, params = fake.last
    assert "q=sz000001,hk00700" in url
    assert "code=" not in url
    # 2) 文本已按 sep 解析为带前缀代码的行
    assert len(rows) == 2
    assert rows[0]["_code"] == "sz000001"
    assert rows[1]["_code"] == "hk00700"


async def test_fetch_https_json_default(session) -> None:
    provider = SecuritiesDataProvider(
        name="小熊", access_method="https", config={"base_url": "https://api.test"}
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        provider_id=provider.id,
        name="标准JSON",
        endpoint="stock/list",
        http_method="GET",
        enabled=True,
        direction="in",
        resp_code_field="code",
        resp_price_field="price",
    )
    session.add(itf)
    await session.flush()

    body = {"code": 0, "msg": "ok", "data": [{"code": "sz000001", "price": "15.00"}]}
    fake = _FakeClient(_FakeResp(json_data=body))
    import app.services.market_data_sync as mds

    original = mds.httpx.AsyncClient
    mds.httpx.AsyncClient = lambda *a, **k: fake  # type: ignore[misc,assignment]
    try:
        svc = MarketDataSyncService(session)
        rows = await svc._fetch_https_raw(itf, {}, ["sz000001"])
    finally:
        mds.httpx.AsyncClient = original  # type: ignore[assignment]

    # 默认 json：走 _normalize_rows 解 data 包 + 默认 code 参数名
    assert rows == [{"code": "sz000001", "price": "15.00"}]
    method, url, params = fake.last
    assert params == {"code": "sz000001"}


async def test_is_placeholder_param_value() -> None:
    """占位符识别：模板示例值判定为占位符，真实业务值不判定。"""
    import app.services.market_data_sync as mds

    for v in ["string", "String ", "示例", "EXAMPLE", "占位符", "placeholder", "xxx"]:
        assert mds._is_placeholder_param_value(v) is True
    # 真实业务值不应被误伤
    for v in ["sz000001", "HK", "600519", "AAPL", ""]:
        assert mds._is_placeholder_param_value(v) is False
    # 非字符串不判定
    assert mds._is_placeholder_param_value(123) is False


async def test_fetch_https_skips_placeholder_params(session) -> None:
    """接口模板含占位符默认值（如 keyWord=string）时，构建请求应丢弃该参数，
    避免上游按占位符过滤成空列表（小熊同学 keyWord=string → data:[]）。"""
    provider = SecuritiesDataProvider(
        name="小熊", access_method="https", config={"base_url": "https://api.test"}
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        provider_id=provider.id,
        name="A股列表",
        endpoint="stock/all",
        http_method="GET",
        enabled=True,
        direction="in",
        resp_code_field="0",
        resp_name_field="1",
    )
    session.add(itf)
    await session.flush()

    fake = _FakeClient(_FakeResp(json_data={"code": 200, "data": []}))
    import app.services.market_data_sync as mds

    original = mds.httpx.AsyncClient
    mds.httpx.AsyncClient = lambda *a, **k: fake  # type: ignore[misc,assignment]
    try:
        svc = MarketDataSyncService(session)
        # 模拟同步引擎直接用 itf.params（含占位符）发起请求
        await svc._fetch_https_raw(itf, {"keyWord": "string", "region": "HK"}, None)
    finally:
        mds.httpx.AsyncClient = original  # type: ignore[assignment]

    method, url, params = fake.last
    # 占位符 keyWord=string 被丢弃，仅 region=HK 进入请求
    assert params == {"region": "HK"}


# --------------------------------------------------------------------------- #
# 3) code_prefix=auto：纯数字代码自动补交易所前缀
# --------------------------------------------------------------------------- #
async def test_infer_cn_exchange() -> None:
    """auto 补全前缀：纯数字 6 位按首位推断 sh/sz/bj；5 位补 hk；非 5/6 位不补。

    规则已统一收敛到 app.services.classification.infer_exchange_prefix（单一事实来源）。
    """
    from app.services.classification import infer_exchange_prefix as f

    assert f("600519") == "sh"   # 沪 A
    assert f("688001") == "sh"   # 科创
    assert f("510300") == "sh"   # 沪基金
    assert f("900901") == "sh"   # 沪 B
    assert f("000001") == "sz"   # 深 A
    assert f("300750") == "sz"   # 创业
    assert f("131800") == "sz"   # 深回购
    assert f("830799") == "bj"   # 北交所旧段(精选层平移)，dropped
    assert f("430047") is None   # 老三板/全国股转(4xxxxx)，无 sh/sz/bj 前缀，dropped
    # 1 开头：沪可转债 11xxxx→sh，深可转债/基金 12/15/16xxxx→sz
    assert f("110000") == "sh"   # 沪可转债
    assert f("113000") == "sh"   # 沪可转债
    assert f("123000") == "sz"   # 深可转债
    assert f("150000") == "sz"   # 深市基金
    assert f("160000") == "sz"   # 深市基金
    # 5 位纯数字 → hk（港股）
    assert f("00700") == "hk"
    assert f("09988") == "hk"
    # 已带前缀 → 从已有前缀推断（_apply_code_prefix 自身也会原样返回）
    assert f("sh600519") == "sh"
    # 非纯数字（字母）/ 空 → 不补
    assert f("AAPL") is None
    assert f("") is None
    # 3/4/7 位不补前缀
    assert f("700") is None
    assert f("6005190") is None
    # 丢弃类别锁定（按 fund-classification-rules.md）：老三板/全国股转 4xxxxx、
    # 北交所旧段 8xxxxx 不写入主数据表；920xxx（北交所新主板段）保留
    from app.services.classification import is_dropped as dropped
    assert dropped("430047") is True     # 老三板/全国股转
    assert dropped("400001") is True     # 退市A股
    assert dropped("420001") is True     # 退市B股
    assert dropped("830799") is True     # 北交所旧段(8xxxxx)
    assert dropped("920020") is False    # 北交所新主板段，保留
    assert dropped("600519") is False    # A股，保留
    assert dropped("510300") is False    # 场内基金，保留
    assert dropped("404001", "航信退债") is True   # 退市可转债落 4xxxxx 段，同属老三板/全国股转，丢弃不入库


async def test_apply_code_prefix_auto() -> None:
    """auto 模式：纯数字补前缀；已带前缀 / 非数字 / 其他模式原样返回。"""
    import app.services.market_data_sync as mds

    # 6 位纯数字 → 按首位补 sh/sz/bj（A股/场内基金）
    assert mds._apply_code_prefix("600519", "auto") == "sh600519"
    assert mds._apply_code_prefix("000001", "auto") == "sz000001"
    assert mds._apply_code_prefix("510300", "auto") == "sh510300"  # 场内基金
    assert mds._apply_code_prefix("110000", "auto") == "sh110000"  # 沪可转债
    assert mds._apply_code_prefix("123000", "auto") == "sz123000"  # 深可转债
    # 5 位纯数字 → 补 hk（港股）
    assert mds._apply_code_prefix("00700", "auto") == "hk00700"
    assert mds._apply_code_prefix("09988", "auto") == "hk09988"
    # 已带前缀 → 不重复加
    assert mds._apply_code_prefix("sh600519", "auto") == "sh600519"
    assert mds._apply_code_prefix("hk00700", "auto") == "hk00700"
    # 非数字（美股）原样
    assert mds._apply_code_prefix("AAPL", "auto") == "AAPL"
    # 位数异常（4 位 / 7 位）→ 原样（不误判）
    assert mds._apply_code_prefix("700", "auto") == "700"
    assert mds._apply_code_prefix("6005190", "auto") == "6005190"
    # 模式非 auto / 空 → 原样
    assert mds._apply_code_prefix("600519", "") == "600519"
    assert mds._apply_code_prefix("600519", None) == "600519"
    assert mds._apply_code_prefix("600519", "auto_dot") == "600519"


async def test_fetch_https_auto_code_prefix(session) -> None:
    """code_prefix=auto 时，请求中的纯数字代码自动补 sh/sz 前缀，已带前缀不动。"""
    provider = SecuritiesDataProvider(
        name="腾讯财经", access_method="https", config={"base_url": "https://qt.gtimg.cn"}
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        provider_id=provider.id,
        name="腾讯实时行情",
        endpoint="stock/quote",
        http_method="GET",
        enabled=True,
        direction="in",
        resp_code_field="_code",
        resp_price_field="3",
        response_parse={
            "format": "json",
            "code_param": "code",
            "code_prefix": "auto",
        },
    )
    session.add(itf)
    await session.flush()

    fake = _FakeClient(_FakeResp(json_data={"code": 0, "data": []}))
    import app.services.market_data_sync as mds

    original = mds.httpx.AsyncClient
    mds.httpx.AsyncClient = lambda *a, **k: fake  # type: ignore[misc,assignment]
    try:
        svc = MarketDataSyncService(session)
        # 混合：纯数字 600519/000001 应补前缀，已带前缀 sh600519 不动
        await svc._fetch_https_raw(itf, {}, ["600519", "000001", "sh600519"])
    finally:
        mds.httpx.AsyncClient = original  # type: ignore[assignment]

    method, url, params = fake.last
    assert params == {"code": "sh600519,sz000001,sh600519"}
