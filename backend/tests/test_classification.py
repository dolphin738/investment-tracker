"""证券分类测试 — 聚焦 Layer-2「债券(BOND) 真正可被推断」。

覆盖：
- 正向：可交债(EB) / 国债 / 公司债 / 企业债 现在推断为 ``SecurityType.BOND``；
- 反向（零回归）：可转债 / 基金 / A股 / 指数 既有的分类判定不得改变；
- 关键反例：``sh000012 国债指数`` 名称含「国债」但必须仍是 INDEX（指数分支在债券兜底之前返回）；
- 债券名称排除词（转债/ETF/LOF…）不得误判为债券。

本文件为纯函数测试，不依赖 DB / 异步夹具，可单独运行：

    pytest backend/tests/test_classification.py -q
"""
from __future__ import annotations

import pytest

from app.models.enums import SecurityType
from app.services.classification import (
    classify_security,
    infer_asset_class,
    infer_exchange,
)


# ---------------------------------------------------------------------------
# 正向：BOND 现在可被自动推断（此前是死枚举成员）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw_code,name",
    [
        # 可交债(EB)：118/132(沪)/120(深)，属上市债券但非可转债
        ("sh132018", "23宝钢EB"),
        ("sz120001", "20XX可交债"),
        # 国债（沪）：010/018/019/020
        ("010303", "03国债(3)"),
        ("019742", "23国债09"),
        ("020019", "20贴现国债19"),
        # 公司债 / 企业债（沪）：100/112/122/124
        ("100001", "企债23"),
        ("112001", "XX企业债"),
        ("122001", "XX公司债"),
        ("124001", "XX企业债"),
    ],
)
def test_bond_now_inferable(raw_code: str, name: str) -> None:
    assert infer_asset_class(raw_code, name=name) == SecurityType.BOND


@pytest.mark.parametrize(
    "raw_code,name",
    [
        ("010303", "03国债(3)"),
        ("019742", "23国债09"),
        ("100001", "企债23"),
        ("122001", "XX公司债"),
        ("124001", "XX企业债"),
    ],
)
def test_bond_asset_class_string(raw_code: str, name: str) -> None:
    """classify_security 应返回中文「债券」大类。"""
    assert classify_security(raw_code, name)["asset_class"] == "债券"


# ---------------------------------------------------------------------------
# 可交债(EB) 修复：此前因 is_cb=False 被丢弃，现应返回「可交债(EB)」
# ---------------------------------------------------------------------------
def test_eb_not_dropped() -> None:
    res = classify_security("sh132018", "23宝钢EB")
    assert res["asset_class"] == "可交债(EB)"
    assert res["exchange"] == "SH"
    # 深市 EB
    res2 = classify_security("sz120001", "20XX可交债")
    assert res2["asset_class"] == "可交债(EB)"
    assert res2["exchange"] == "SZ"


# ---------------------------------------------------------------------------
# 反向：既有分类不得回归
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "code",
    [
        "110075",  # 沪可转债
        "113043",  # 沪可转债
        "123254",  # 深可转债
        "127085",  # 深可转债
        "128129",  # 深可转债
    ],
)
def test_convertible_bond_unchanged(code: str) -> None:
    assert infer_asset_class(code) == SecurityType.CONVERTIBLE_BOND


def test_fund_unchanged() -> None:
    # 510300 沪深300ETF（沪）、159915 易方达创业板ETF（深）均为场内基金
    assert infer_asset_class("510300", name="沪深300ETF") == SecurityType.ON_EXCHANGE_FUND
    assert infer_asset_class("159915", name="易方达创业板ETF") == SecurityType.ON_EXCHANGE_FUND
    # 180xxx 仍走基金分支（1800xx 场外 / 1801xx–1808xx 场内REITs），必为基金大类
    assert infer_asset_class("180001") in (
        SecurityType.ON_EXCHANGE_FUND,
        SecurityType.OFF_EXCHANGE_FUND,
    )


def test_stock_unchanged() -> None:
    assert infer_asset_class("600519") == SecurityType.STOCK  # 贵州茅台
    assert infer_asset_class("000001") == SecurityType.STOCK  # 平安银行
    assert infer_asset_class("300750") == SecurityType.STOCK  # 宁德时代


def test_index_unchanged_even_with_guo_zhai_name() -> None:
    """关键反例：名称含「国债」但代码段为指数段，必须仍为 INDEX。

    注：``infer_asset_class(code, exchange, name)`` 的 name 为第 3 形参，须以
    关键字传入；若误作第 2 位置参数会落入 exchange 形参、name 变空，导致裸码
    ``000012`` 退化为 A股（南玻A）。此处以 ``name=`` 关键字正确传名。
    """
    res = classify_security("sh000012", "国债指数")
    assert res["asset_class"] == "指数"
    # sh 前缀 + 000xxx 指数段 → INDEX（即便名称含「国债」也不被债券兜底误伤）
    assert infer_asset_class("sh000012", name="国债指数") == SecurityType.INDEX
    # 裸码 + 名称兜底（名称含指数关键词「国债」）→ 仍 INDEX（既有行为不变）
    assert infer_asset_class("000012", name="国债指数") == SecurityType.INDEX
    # 反向：裸码且无名称为 A股（南玻A），保持 STOCK，印证名称兜底非无条件生效
    assert infer_asset_class("000012") == SecurityType.STOCK


# ---------------------------------------------------------------------------
# 债券名称排除词：含 转债/ETF/LOF 等不得误判为债券
# ---------------------------------------------------------------------------
def test_bond_name_exclusion() -> None:
    # 999999 为未分类代码，名称同时含债券词与排除词 → 不应改判为债券
    assert infer_asset_class("999999", name="XX企债ETF") != SecurityType.BOND
    assert infer_asset_class("999999", name="XX企债LOF") != SecurityType.BOND
    # 可转债名称（非 CB 段代码）仍不应被债券通道误收
    assert infer_asset_class("999999", name="XX转债") != SecurityType.BOND


def test_non_bond_stays_uncategorized() -> None:
    """与债券段/名称均不匹配的未分类代码，保持 UNCATEGORIZED（不误伤）。"""
    assert infer_asset_class("999999", name="") == SecurityType.UNCATEGORIZED


# ---------------------------------------------------------------------------
# B5：infer_exchange 债券段修正（沪市债券现券段此前被 head 规则误归 SZ）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "code",
    [
        "010303",  # 国债
        "018001",  # 政策性银行金融债
        "019742",  # 国债
        "020019",  # 记账式贴现国债
        "100001",  # 债券回售 / 公司债
        "101001",  # 地方政府债
        "112001",  # 企业债
        "122001",  # 公司债 / 企业债
        "124001",  # 企业债
    ],
)
def test_infer_exchange_bond_segments_sh(code: str) -> None:
    """债券现券段应归 SH（修正历史误归 SZ）。"""
    assert infer_exchange(code) == "SH"
    # 带显式 sh 前缀自然仍为 SH
    assert infer_exchange(f"sh{code}") == "SH"


def test_infer_exchange_bond_fix_no_regression() -> None:
    """B5 修正不得波及其它已分类证券。"""
    # A股
    assert infer_exchange("600519") == "SH"  # 贵州茅台
    assert infer_exchange("000001") == "SZ"  # 平安银行（深市主板，0 前缀但非债券段）
    assert infer_exchange("300750") == "SZ"  # 宁德时代
    # 基金
    assert infer_exchange("510300") == "SH"  # 沪深300ETF
    assert infer_exchange("159915") == "SZ"  # 创业板ETF
    # 可转债（沪，11xxxx → SH）
    assert infer_exchange("110075") == "SH"
    assert infer_exchange("113043") == "SH"
    # 可转债（深，12xxxx → SZ）
    assert infer_exchange("123254") == "SZ"
    assert infer_exchange("127085") == "SZ"
