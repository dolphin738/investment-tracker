"""回补 / 日抓测试拆分后的**共享 helper**（避免多文件重复造数据）。

自 ``test_market_daily_price_sync.py`` 抽出（T04 测试拆分）。``session`` fixture 由
``backend/conftest.py`` 提供，本模块只放**数据构造**辅助：

- ``uid()``：随机 UUID 字符串（主键）；
- ``add_master(session, code)``：造一只「证券」主数据（code 经 ``_normalize_master_code`` 规范化）；
- ``seed_sdk_quote_source(session)``：造 SDK 行情源 + 单行配置表，返回 itf；
- ``seed_https_quote_source(session, *, max_codes_per_request)``：造 HTTPS 行情源 + 单行配置表，返回 itf。

供 ``test_market_daily_price_sync.py`` / ``test_market_daily_price_logging.py`` /
``test_market_price_backfill_pending.py`` 共同 import。
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
)
from app.models.enums import QuoteProviderAccessMethod, SecurityType
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    _normalize_master_code,
    infer_exchange,
)


def uid() -> str:
    return str(uuid.uuid4())


async def add_master(session, code="600000"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


async def seed_sdk_quote_source(session):
    """造 SDK 行情源 + 配置表，返回 itf（供 daily_close_fetch 回补入口测试复用）。"""
    provider = SecuritiesDataProvider(
        id=uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(
                                      price_source_interface_id=itf.id))
    return itf


async def seed_https_quote_source(session, *, max_codes_per_request: int = 800):
    """造 HTTPS 行情源 + 配置表（price_source_interface_id 指向它），返回 itf。

    与既有内联造法等价，抽成辅助以复用；``max_codes_per_request`` 可控批次大小
    （置 1 即「每批 1 只」→ 便于构造「部分失败」场景）。
    """
    provider = SecuritiesDataProvider(
        id=uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": max_codes_per_request},
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(
                                      price_source_interface_id=itf.id))
    await session.flush()
    return itf
