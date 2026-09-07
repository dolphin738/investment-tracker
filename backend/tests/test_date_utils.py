"""日期工具单测 —— ``parse_date`` 为全仓唯一日期解析实现（P2-7 收敛）。

收敛自两处重复实现，两侧历史口径均须保持：

- 导入侧（原 ``data_transfer._parse_date``）：ISO / 斜杠；
- 采集侧（原 ``dividend_sync._parse_date``）：akshare 紧凑 YYYYMMDD / 中文日期 /
  数字下标行 / 哨兵空值。
"""
from datetime import date

from app.core.date_utils import parse_date


def test_parse_date_iso_and_slash():
    """守护导入侧口径（原 data_transfer._parse_date）：ISO + 斜杠，非法返回 None。"""
    assert parse_date("2024-01-01") == date(2024, 1, 1)
    assert parse_date("2024/01/01") == date(2024, 1, 1)
    assert parse_date("abc") is None
    assert parse_date("") is None


def test_parse_date_compact_chinese_and_sentinels():
    """守护采集侧口径（原 dividend_sync._parse_date）：紧凑 / 中文 / 数字 / 哨兵。"""
    assert parse_date("20241214") == date(2024, 12, 14)
    assert parse_date(20241214) == date(2024, 12, 14)  # 数字下标行也兼容
    assert parse_date("2024年12月14日") == date(2024, 12, 14)
    assert parse_date(None) is None
    assert parse_date("-") is None
    assert parse_date("nan") is None
    assert parse_date("2024-13-40") is None  # 非法月份 / 日期


def test_parse_date_no_duplicate_implementation():
    """反向断言（P2-7）：任一原持有方再长出私有实现即失败。"""
    import app.services.data_transfer as dt
    import app.services.dividend_period as dp

    assert not hasattr(dt, "_parse_date"), "data_transfer 又长出了私有 _parse_date"
    assert not hasattr(dp, "parse_date"), "dividend_period 又长出了本地 parse_date"
