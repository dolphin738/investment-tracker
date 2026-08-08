"""审计缺陷回归测试 — 对齐 docs/code-review-2026-08-09.md §5。

逐项覆盖 HIGH/MEDIUM/LOW 缺陷的「可观测行为」：
- H1  XIRR 极端值落库溢出 → 量程保护 + 单日 try/except，重算不 500、XIRR 置 NULL
- M1  首笔出入金必须为存入（SELL 首笔拒绝）
- M2  GET /holdings 多 securityId 不丢数据
- M3  汇总收益率量纲统一为比值（/summary 与 /portfolios/summary 一致）
- M4  导入数量/价格放开到 6 位小数（碎股/高精度报价不再误拒）
- L1  事件日期改「更晚」后重建 [old,new) 陈旧派生快照
- L2  导入 SELL 执行 §9.2 卖出硬校验（超额整批拒绝）
- L3  入参 amount/quantity/price > 0 校验（Pydantic）
- L4  compute_range 在 start 之前无 DailyNav 时回退到最早事件日
- L5  同 as_of 多条 CashBalance 确定性取最新创建一行

注意：集成测试依赖本地 PostgreSQL（investment_tracker），由 conftest 注入引擎。
每个测试用唯一邮箱，互不污染。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio

D1 = date(2024, 1, 2)
D2 = date(2024, 1, 10)


async def _create_portfolio(client, h, name="组合"):
    r = await client.post("/api/portfolios", headers=h, json={"name": name})
    assert env(r)[0] == 200
    return r.json()["data"]["id"]


async def _seed_position(client, h, pid, sec_code="600000"):
    """入金10万 + 现金9万 + 标的 + 现价 + 买入1000股@10；返回 (sec_id, trade_id)。"""
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h, json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    await client.post(
        f"/api/portfolios/{pid}/cash-balances",
        headers=h, json={"asOf": str(D1), "amount": 90000},
    )
    sec = (await client.post(
        f"/api/portfolios/{pid}/securities",
        headers=h, json={"code": sec_code, "name": sec_code, "type": "STOCK"},
    )).json()["data"]
    sec_id = sec["id"]
    await client.post(
        f"/api/portfolios/{pid}/security-prices",
        headers=h, json={"securityId": sec_id, "price": 10, "asOf": str(D1)},
    )
    tr = (await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h, json={
            "date": str(D1), "securityId": sec_id, "side": "BUY_SEC",
            "quantity": 1000, "price": 10, "fee": 0,
        },
    )).json()["data"]
    return sec_id, tr["id"]


# ── H1 ────────────────────────────────────────────────────────────────────
async def test_h1_xirr_overflow_protected(client):
    """8 日翻倍（100→200）XIRR ≈2^45.6-1 ≈5.4e13 超 NUMERIC(20,8) 量程；应置 NULL 而非 500。"""
    creds = await register_login(client, "h1@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "H1组合")
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h, json={"date": str(D1), "type": "BUY", "amount": 100},
    )
    await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h, json={"date": str(D2), "totalAsset": 200},
    )
    # 重算不应 500
    r = await client.post(f"/api/portfolios/{pid}/recalculate", headers=h)
    assert env(r)[0] == 200
    # 最新 XIRR 应为 None（量程外按不可计算处理）。
    # /xirr/latest 会过滤 xirr_value IS NOT NULL 的行，故读完整时间序列末点。
    r = await client.get(f"/api/portfolios/{pid}/xirr", headers=h)
    _, _, series, _ = env(r)
    assert series, "应产生 XIRR 时间序列"
    assert series[-1]["value"] is None


# ── M1 ────────────────────────────────────────────────────────────────────
async def test_m1_first_cashflow_must_be_buy(client):
    """首笔出入金为 SELL → 400；随后 BUY 成功。"""
    creds = await register_login(client, "m1@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "M1组合")
    r = await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h, json={"date": str(D1), "type": "SELL", "amount": 1000},
    )
    status, code, _, _ = env(r)
    assert status == 400 and code == 2000
    # 合法首笔存入
    r = await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h, json={"date": str(D1), "type": "BUY", "amount": 1000},
    )
    assert env(r)[0] == 200


# ── M2 ────────────────────────────────────────────────────────────────────
async def test_m2_holdings_multi_securityid(client):
    """多 securityId 查询应返回全部，不静默丢数据。"""
    creds = await register_login(client, "m2@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "M2组合")
    sec_a, _ = await _seed_position(client, h, pid, "600000")
    sec_b, _ = await _seed_position(client, h, pid, "600001")
    r = await client.get(
        f"/api/portfolios/{pid}/holdings",
        headers=h,
        params={"asOf": str(D1), "securityId": f"{sec_a},{sec_b}"},
    )
    _, _, holdings, _ = env(r)
    ids = {v["securityId"] for v in holdings}
    assert sec_a in ids and sec_b in ids
    assert len(holdings) == 2


# ── M3 ────────────────────────────────────────────────────────────────────
async def test_m3_summary_return_rate_ratio_consistency(client):
    """/summary（单）与 /portfolios/summary（列）yearReturnRate 同为比值，不 100×。"""
    creds = await register_login(client, "m3@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "M3组合")
    await _seed_position(client, h, pid)
    # 制造 10% 增益的 D2 快照
    await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h, json={"date": str(D2), "totalAsset": 110000},
    )
    await client.post(
        f"/api/portfolios/{pid}/recalculate-range",
        headers=h, json={"startDate": str(D1)},
    )
    # 单组合摘要
    r = await client.get(f"/api/portfolios/{pid}/summary", headers=h)
    _, _, single, _ = env(r)
    s_val = Decimal(single["yearReturnRate"])
    # 列表摘要
    r = await client.get("/api/portfolios/summary", headers=h)
    _, _, rows, _ = env(r)
    row = next(x for x in rows if x["id"] == pid)
    l_val = Decimal(row["yearReturnRate"])
    # 两端点量纲一致
    assert s_val == l_val
    # 比值为小数（10% 增益 → ≈0.1），明确非百分比（10.0）
    assert abs(s_val) < Decimal("1")


# ── M4 ────────────────────────────────────────────────────────────────────
async def test_m4_import_6decimals_accepted(client):
    """导入数量/价格 6 位小数（碎股/高精度报价）应被接受，不再 INVALID_DECIMAL_PRECISION。"""
    creds = await register_login(client, "m4@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "M4组合")
    await client.post(
        f"/api/portfolios/{pid}/securities",
        headers=h, json={"code": "600000", "name": "平安", "type": "STOCK"},
    )
    csv_text = (
        "date,securityCode,side,quantity,price,fee\n"
        "2024-01-02,600000,BUY_SEC,10.123456,12.345678,0\n"
    )
    files = {"file": ("trades.csv", csv_text.encode("utf-8"), "text/csv")}
    r = await client.post(
        f"/api/portfolios/{pid}/import/preview",
        headers=h, data={"type": "securityTrades"}, files=files,
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    # 不含精度错误码
    err_codes = {e["code"] for e in data["errors"]}
    assert "INVALID_DECIMAL_PRECISION" not in err_codes
    assert data["validRows"] == 1


# ── L1 ────────────────────────────────────────────────────────────────────
async def test_l1_patch_later_date_rebuilds_old_snapshot(client):
    """交易日期改「更晚」后，旧日期派生快照须重建（不再陈旧）。"""
    creds = await register_login(client, "l1@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "L1组合")
    _, trade_id = await _seed_position(client, h, pid)
    # D1 派生快照：市值 10000 + 现金 90000 = 100000
    r = await client.get(f"/api/portfolios/{pid}/snapshots/{D1}", headers=h)
    assert Decimal(env(r)[2]["totalAsset"]) == Decimal("100000")
    # 把交易改到更晚的 D2
    r = await client.patch(
        f"/api/portfolios/{pid}/security-trades/{trade_id}",
        headers=h, json={"date": str(D2)},
    )
    assert env(r)[0] == 200
    # D1 现在无交易 → 市值 0 + 现金 90000 = 90000（重建后，非陈旧的 100000）
    r = await client.get(f"/api/portfolios/{pid}/snapshots/{D1}", headers=h)
    assert Decimal(env(r)[2]["totalAsset"]) == Decimal("90000")


# ── L2 ────────────────────────────────────────────────────────────────────
async def test_l2_import_oversell_rejected(client):
    """导入超额 SELL（超过既有持仓）应整批拒绝（VALIDATION_FAILED 2000）。"""
    creds = await register_login(client, "l2@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "L2组合")
    await _seed_position(client, h, pid)  # 持有 1000 股
    # 预览一份超额 SELL（2000 > 1000）
    csv_text = (
        "date,securityCode,side,quantity,price,fee\n"
        "2024-01-02,600000,SELL_SEC,2000,10,0\n"
    )
    files = {"file": ("trades.csv", csv_text.encode("utf-8"), "text/csv")}
    r = await client.post(
        f"/api/portfolios/{pid}/import/preview",
        headers=h, data={"type": "securityTrades"}, files=files,
    )
    _, _, prev, _ = env(r)
    token = prev["token"]
    # 提交应被卖出硬校验拒绝
    r = await client.post(
        f"/api/portfolios/{pid}/import/commit",
        headers=h, json={"type": "securityTrades", "token": token},
    )
    status, code, _, _ = env(r)
    assert status == 400 and code == 2000


# ── L3 ────────────────────────────────────────────────────────────────────
async def test_l3_negative_amount_rejected(client):
    """入参 amount/quantity/price ≤ 0 应被 Pydantic 拒绝（validation_exception_handler → HTTP 400 / 2000）。"""
    creds = await register_login(client, "l3@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "L3组合")
    # 出入金金额 ≤ 0
    r = await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h, json={"date": str(D1), "type": "BUY", "amount": 0},
    )
    assert env(r)[0] == 400
    # 交易数量 ≤ 0
    sec = (await client.post(
        f"/api/portfolios/{pid}/securities",
        headers=h, json={"code": "600000", "name": "x", "type": "STOCK"},
    )).json()["data"]["id"]
    r = await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h, json={
            "date": str(D1), "securityId": sec, "side": "BUY_SEC",
            "quantity": 0, "price": 10, "fee": 0,
        },
    )
    assert env(r)[0] == 400
    # 交易价格 ≤ 0
    r = await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h, json={
            "date": str(D1), "securityId": sec, "side": "BUY_SEC",
            "quantity": 100, "price": 0, "fee": 0,
        },
    )
    assert env(r)[0] == 400


# ── L4 ────────────────────────────────────────────────────────────────────
async def test_l4_recalculate_start_rollback(client):
    """startDate 落在成立日之后且无前缀 DailyNav 时，回退到最早事件日。"""
    creds = await register_login(client, "l4@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "L4组合")
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h, json={"date": str(D1), "type": "BUY", "amount": 1000},
    )
    await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h, json={"date": str(D1), "totalAsset": 1000},
    )
    await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h, json={"date": str(D2), "totalAsset": 1100},
    )
    # 从 D2 触发重算：应回退到最早事件日 D1，处理 D1+D2 共 2 日
    r = await client.post(
        f"/api/portfolios/{pid}/recalculate-range",
        headers=h, json={"startDate": str(D2)},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["affectedDates"] >= 2  # D1（回退）+ D2


# ── L5 ────────────────────────────────────────────────────────────────────
async def test_l5_cash_balance_deterministic_latest(client):
    """同 as_of 多条现金余额时，确定性取最新创建一行（不随路径分歧）。

    注意：create_cashbalance API 已改为按 as_of upsert（同 as_of 只保留一行），
    无法经 API 造出多行；故直接经 DB 会话插入两条同 as_of 余额，验证读取端
    （_latest_cash_balance / computeDerivedBatch）确定性取最新创建一行。
    """
    creds = await register_login(client, "l5@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "L5组合")
    # 直接插入两条同 as_of 现金余额（第二条更晚创建、金额更小）
    from app.db.database import AsyncSessionLocal
    from app.models import CashBalance

    async with AsyncSessionLocal() as s:
        s.add(CashBalance(portfolio_id=pid, as_of=D1, amount=Decimal("90000")))
        s.add(CashBalance(portfolio_id=pid, as_of=D1, amount=Decimal("80000")))
        await s.commit()
    # 手工快照触发派生计算，读取 derivedTotalAsset（无持仓 → 仅现金）
    r = await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h, json={"date": str(D1), "totalAsset": 1},
    )
    _, _, snap, _ = env(r)
    # 应取最新创建（80000）一行，而非 90000 或任意
    assert Decimal(snap["derivedTotalAsset"]) == Decimal("80000")
