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
            "quantity": 1000, "costPrice": 10,
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
    _, _, data, _ = env(r)
    holdings = data["items"]
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
        "date,securityCode,side,quantity,costPrice,feeTotal\n"
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
        "date,securityCode,side,quantity,costPrice,feeTotal\n"
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
            "quantity": 0, "costPrice": 10,
        },
    )
    assert env(r)[0] == 400
    # 交易价格 ≤ 0
    r = await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h, json={
            "date": str(D1), "securityId": sec, "side": "BUY_SEC",
            "quantity": 100, "costPrice": 0,
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


# ═══════════════════════════════════════════════════════════════════════════
# 用户提交的 7 个系统缺陷回归（2026-08-09）
# ═══════════════════════════════════════════════════════════════════════════

# ── 缺陷1：URL 头像更换清理旧文件 ─────────────────────────────────────────
async def test_defect1_url_avatar_clears_old_file(client):
    """更换 URL 头像时旧上传文件应被删除，不残留孤立文件。"""
    from app.core.config import get_settings
    from pathlib import Path

    creds = await register_login(client, "d1avatar@example.com", "pw123456")
    h = auth(creds["token"])
    # 先上传一个头像文件（合法 JPEG 魔数）
    content = (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
    )
    r = await client.post(
        "/api/upload/avatar", headers=h,
        files={"file": ("a.jpg", content, "image/jpeg")},
    )
    status, _, data, _ = env(r)
    assert status == 200
    old_url = data["url"]
    fname = old_url.rsplit("/", 1)[-1]
    old_path = Path(get_settings().UPLOAD_DIR) / "avatar" / fname
    assert old_path.exists()
    # 再更换为 URL 头像
    new_avatar = "https://example.com/pic.png"
    r = await client.patch(
        "/api/auth/profile", headers=h, json={"avatar": new_avatar}
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["avatar"] == new_avatar
    # 旧文件应被清理
    assert not old_path.exists()


# ── 缺陷2：成立日动态跟踪实时刷新（后端口径，配合前端失效） ──────────────────
async def test_defect2_cashflow_date_change_recomputes_base_date(client):
    """新增更早的存入 → 组合成立日（base_date）应前移。"""
    creds = await register_login(client, "d2@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "D2组合")
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    r = await client.get(f"/api/portfolios/{pid}/summary", headers=h)
    assert env(r)[2]["inceptionDate"] == str(D1)
    # 新增更早的存入 → 成立日应前移到 D0
    d0 = date(2023, 12, 1)
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(d0), "type": "BUY", "amount": 50000},
    )
    r = await client.get(f"/api/portfolios/{pid}/summary", headers=h)
    assert env(r)[2]["inceptionDate"] == str(d0)


# ── 缺陷3：删除出入金联动清理 0 值 DERIVED 快照 ────────────────────────────
async def test_defect3_delete_cashflow_clears_zero_derived_snapshot(client):
    """删除「唯一事件」出入金后，当日 0 值 DERIVED 快照应被联动清除。"""
    creds = await register_login(client, "d3@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "D3组合")
    # 仅一笔出入金（无持仓/现金余额）→ 当日派生 0 值 DERIVED 快照
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        params={"startDate": str(D1), "endDate": str(D1)},
    )
    assert env(r)[2]["total"] >= 1
    # 获取并删除该出入金
    cf_list = (await client.get(f"/api/portfolios/{pid}/cashflows", headers=h)).json()["data"]["items"]
    cf_id = cf_list[0]["id"]
    r = await client.delete(f"/api/portfolios/{pid}/cashflows/{cf_id}", headers=h)
    assert env(r)[0] == 200
    # 当日快照应已清空
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        params={"startDate": str(D1), "endDate": str(D1)},
    )
    assert env(r)[2]["total"] == 0


# ── 缺陷4-A：概览页持仓汇总（持仓市值） ────────────────────────────────────
async def test_defect4a_overview_holdings_summary(client):
    """概览页应下发持仓汇总（持仓市值），用于「资产构成·持仓市值」卡。"""
    creds = await register_login(client, "d4a@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "D4A组合")
    await _seed_position(client, h, pid)  # 1000 股 @10 → 市值 10000
    r = await client.get(f"/api/portfolios/{pid}/overview", headers=h)
    status, _, data, _ = env(r)
    assert status == 200
    hs = data["holdingsSummary"]
    assert hs is not None
    assert Decimal(hs["totalMarketValue"]) == Decimal("10000")


# ── 缺陷4-B + 缺陷5：单指标 /nav 也应下发 cumulativeNav/yearNav ─────────────
async def test_defect4b5_nav_single_metric_returns_nav_fields(client):
    """累计/当年/对比三种 metric 都必须下发对应 nav 字段（否则前端曲线不渲染）。"""
    creds = await register_login(client, "d4b5@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "D4B5组合")
    await _seed_position(client, h, pid)
    await client.post(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        json={"date": str(D2), "totalAsset": 110000},
    )
    await client.post(
        f"/api/portfolios/{pid}/recalculate-range", headers=h,
        json={"startDate": str(D1)},
    )
    r = await client.get(
        f"/api/portfolios/{pid}/nav", headers=h, params={"metric": "cumulative"}
    )
    assert all(p["cumulativeNav"] is not None for p in env(r)[2])
    r = await client.get(
        f"/api/portfolios/{pid}/nav", headers=h, params={"metric": "year"}
    )
    assert all(p["yearNav"] is not None for p in env(r)[2])
    r = await client.get(
        f"/api/portfolios/{pid}/nav", headers=h, params={"metric": "both"}
    )
    assert all(
        p["cumulativeNav"] is not None and p["yearNav"] is not None
        for p in env(r)[2]
    )


# ── 缺陷6：账户统计字段对齐（不再 undefined） ──────────────────────────────
async def test_defect6_account_stats_fields(client):
    """账户统计应返回前端期望字段（组合/出入金/买卖/记录天数/起止日）。"""
    creds = await register_login(client, "d6@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "D6组合")
    await _seed_position(client, h, pid)  # 含 1 笔出入金 + 1 笔买卖
    r = await client.get("/api/account/stats", headers=h)
    status, _, data, _ = env(r)
    assert status == 200
    assert data["portfolioCount"] == 1
    assert data["cashflowCount"] >= 1
    assert data["tradeCount"] >= 1
    assert data["snapshotDays"] >= 1
    assert data["recordDays"] >= 1
    assert data["firstDate"] is not None
    assert data["lastDate"] is not None


# ── 缺陷7：历史资产「来源」筛选服务端生效 ──────────────────────────────────
async def test_defect7_snapshot_source_filter(client):
    """来源筛选应在服务端生效（DERIVED/MANUAL 各只返回对应来源）。"""
    creds = await register_login(client, "d7@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "D7组合")
    # 派生快照（出入金触发）
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    # 手工快照
    await client.post(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        json={"date": str(D2), "totalAsset": 100000},
    )
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        params={"source": "DERIVED"},
    )
    derived = env(r)[2]["items"]
    assert derived and all(s["source"] == "DERIVED" for s in derived)
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        params={"source": "MANUAL"},
    )
    manual = env(r)[2]["items"]
    assert len(manual) == 1 and all(s["source"] == "MANUAL" for s in manual)


# ═══════════════════════════════════════════════════════════════════════════
# 用户提交的系统缺陷（第二批：5 个异常）— 问题2/3/4 回归
# ═══════════════════════════════════════════════════════════════════════════

# ── 问题2-A：删除唯一出入金后，今日 0 值孤儿快照也应消失 ──────────────────
async def test_p2a_delete_only_cashflow_no_today_zero(client):
    """删除唯一一笔出入金后，区间内（含今日）不应残留任何 DERIVED 快照。

    验证 recalculation._get_event_dates 仅在存在事件时才并入今日，
    以及 data.delete_cashflow 统一调用 prune_zero_orphans。
    """
    creds = await register_login(client, "p2a@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h)
    cf = (await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 10000},
    )).json()["data"]
    # 删除前：存在 D1 派生快照（及今日 0 快照）
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h, params={"startDate": str(D1)}
    )
    assert env(r)[2]["total"] >= 1
    # 删除出入金
    r = await client.delete(f"/api/portfolios/{pid}/cashflows/{cf['id']}", headers=h)
    assert env(r)[0] == 200
    # 删除后：区间内无任何快照（无 0 孤儿）
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h, params={"startDate": str(D1)}
    )
    assert env(r)[2]["total"] == 0


# ── 问题2-B：删除现金余额后，残留的 0 值 DERIVED 快照应被清理 ───────────────
async def test_p2b_delete_cashbalance_no_zero_orphan(client):
    """删现金余额（出入金仍在）→ 当日仅余出入金→0，应清理该 0 值孤儿快照。

    此前 delete_cashbalance 未调用任何 prune，会残留 0 值 DERIVED 快照。
    """
    creds = await register_login(client, "p2b@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h)
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 10000},
    )
    await client.post(
        f"/api/portfolios/{pid}/cash-balances", headers=h,
        json={"asOf": str(D1), "amount": 7984},
    )
    cb_list = (await client.get(
        f"/api/portfolios/{pid}/cash-balances", headers=h
    )).json()["data"]["items"]
    cb_id = cb_list[0]["id"]
    r = await client.delete(
        f"/api/portfolios/{pid}/cash-balances/{cb_id}", headers=h
    )
    assert env(r)[0] == 200
    # 不应残留任何 0 值 DERIVED 快照
    r = await client.get(f"/api/portfolios/{pid}/snapshots", headers=h)
    items = env(r)[2]["items"]
    zero = [s for s in items if str(s["totalAsset"]) in ("0", "0.00", "0.0")]
    assert zero == [], f"残留 0 值孤儿快照: {zero}"


# ── 问题2-C：删除买卖后，陈旧 DERIVED 快照应被清理 ───────────────────────
async def test_p2c_delete_trade_no_orphan(client):
    """删买卖（无现金/无现价）→ 当日 COST_BASED 快照陈旧，应被清理（不再残留）。"""
    creds = await register_login(client, "p2c@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h)
    sec = (await client.post(
        f"/api/portfolios/{pid}/securities", headers=h,
        json={"code": "600000", "name": "x", "type": "STOCK"},
    )).json()["data"]
    tr = (await client.post(
        f"/api/portfolios/{pid}/security-trades", headers=h,
        json={"date": str(D1), "securityId": sec["id"], "side": "BUY_SEC",
              "quantity": 100, "costPrice": 20.16},
    )).json()["data"]
    # 删除买卖
    r = await client.delete(
        f"/api/portfolios/{pid}/security-trades/{tr['id']}", headers=h
    )
    assert env(r)[0] == 200
    # 删除后：无任何快照残留
    r = await client.get(
        f"/api/portfolios/{pid}/snapshots", headers=h, params={"startDate": str(D1)}
    )
    assert env(r)[2]["total"] == 0


# ── 问题3：概览页持仓无行情记录不应 500 ─────────────────────────────────
async def test_p3_overview_no_price_not_500(client):
    """录入入金/现金/买入但无现价 → 概览页此前抛 ValueError（min 空集合）→ 500。

    修复后：返回 200，totalAsset=入金总额，持仓市值=成本估值，freshness 正确标记陈旧。
    """
    creds = await register_login(client, "p3b@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h)
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 10000},
    )
    await client.post(
        f"/api/portfolios/{pid}/cash-balances", headers=h,
        json={"asOf": str(D1), "amount": 7984},
    )
    sec = (await client.post(
        f"/api/portfolios/{pid}/securities", headers=h,
        json={"code": "600000", "name": "x", "type": "STOCK"},
    )).json()["data"]
    await client.post(
        f"/api/portfolios/{pid}/security-trades", headers=h,
        json={"date": str(D1), "securityId": sec["id"], "side": "BUY_SEC",
              "quantity": 100, "costPrice": 20.16},
    )
    r = await client.get(f"/api/portfolios/{pid}/overview", headers=h)
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["totalAsset"] == "10000.00"
    assert data["holdingsSummary"]["totalMarketValue"] == "2016.000000000000"
    assert data["freshness"]["isStale"] is True


# ── 问题4：持仓页类型筛选器后端生效 ─────────────────────────────────────
async def test_p4_holdings_type_filter(client):
    """持仓类型筛选（types=逗号分隔）应真正过滤结果，而非此前被 FastAPI 忽略。"""
    creds = await register_login(client, "p4@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h)
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    await client.post(
        f"/api/portfolios/{pid}/cash-balances", headers=h,
        json={"asOf": str(D1), "amount": 90000},
    )
    stock = (await client.post(
        f"/api/portfolios/{pid}/securities", headers=h,
        json={"code": "600000", "name": "股", "type": "STOCK"},
    )).json()["data"]
    fund = (await client.post(
        f"/api/portfolios/{pid}/securities", headers=h,
        json={"code": "500001", "name": "基", "type": "FUND"},
    )).json()["data"]
    await client.post(
        f"/api/portfolios/{pid}/security-prices", headers=h,
        json={"securityId": stock["id"], "price": 10, "asOf": str(D1)},
    )
    await client.post(
        f"/api/portfolios/{pid}/security-prices", headers=h,
        json={"securityId": fund["id"], "price": 10, "asOf": str(D1)},
    )
    await client.post(
        f"/api/portfolios/{pid}/security-trades", headers=h,
        json={"date": str(D1), "securityId": stock["id"], "side": "BUY_SEC",
              "quantity": 100, "costPrice": 10},
    )
    await client.post(
        f"/api/portfolios/{pid}/security-trades", headers=h,
        json={"date": str(D1), "securityId": fund["id"], "side": "BUY_SEC",
              "quantity": 100, "costPrice": 10},
    )
    # 无筛选 → 2 个
    r = await client.get(
        f"/api/portfolios/{pid}/holdings", headers=h, params={"asOf": str(D1)}
    )
    _, _, allh, _ = env(r)
    assert len(allh["items"]) == 2
    # 仅 STOCK
    r = await client.get(
        f"/api/portfolios/{pid}/holdings", headers=h,
        params={"asOf": str(D1), "types": "STOCK"},
    )
    _, _, sth, _ = env(r)
    assert len(sth["items"]) == 1 and sth["items"][0]["securityType"] == "STOCK"
    # 仅 FUND
    r = await client.get(
        f"/api/portfolios/{pid}/holdings", headers=h,
        params={"asOf": str(D1), "types": "FUND"},
    )
    _, _, fnd, _ = env(r)
    assert len(fnd["items"]) == 1 and fnd["items"][0]["securityType"] == "FUND"
    # 多类型
    r = await client.get(
        f"/api/portfolios/{pid}/holdings", headers=h,
        params={"asOf": str(D1), "types": "STOCK,FUND"},
    )
    _, _, both, _ = env(r)
    assert len(both["items"]) == 2


# ── 用户缺陷5：删除手工总资产记录后必须补回当日 DERIVED 自动记录 ────────────
async def test_userbug5_delete_manual_snapshot_regenerates_derived(client):
    """删除某日（如 8/10）误编辑的手工记录后，系统必须自动补回当日 DERIVED 自动记录，
    否则该日无任何快照 → XIRR/净值断链、截止当日收益无法产出。

    场景：D1 为完整事件日（持仓+现金），D2 仅有一条手工总资产记录（当日无底层事件）。
    删除 D2 手工记录后，因 D1 事件 ≤ D2，has_any_event_upto(D2)=True，
    必须重新落库 D2 的 DERIVED 快照，且 /xirr 能计算到 D2。
    """
    creds = await register_login(client, "ub5@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "UB5组合")
    await _seed_position(client, h, pid)  # D1 事件日：市值10000+现金90000=100000
    # D2 仅手工记录（无当日事件）
    r = await client.post(
        f"/api/portfolios/{pid}/snapshots", headers=h,
        json={"date": str(D2), "totalAsset": 110000},
    )
    assert env(r)[0] == 200
    # 确认写入的是 MANUAL
    r = await client.get(f"/api/portfolios/{pid}/snapshots/{D2}", headers=h)
    status, _, snap, _ = env(r)
    assert status == 200
    assert snap["source"] == "MANUAL"
    snap_id = snap["id"]
    # 删除该手工记录
    r = await client.delete(
        f"/api/portfolios/{pid}/snapshots/{snap_id}", headers=h
    )
    assert env(r)[0] == 200
    # 删除后：D2 必须重新出现 DERIVED 自动记录（补回）
    r = await client.get(f"/api/portfolios/{pid}/snapshots/{D2}", headers=h)
    status, _, snap, _ = env(r)
    assert status == 200, "删除手工记录后当日自动记录必须补回（不应 404）"
    assert snap["source"] == "DERIVED"
    # XIRR/净值链不断：时间序列应覆盖 D2
    r = await client.get(f"/api/portfolios/{pid}/xirr", headers=h)
    _, _, series, _ = env(r)
    assert str(D2) in {p["date"] for p in series}


# ── 用户缺陷2：概览 freshness.reasons 必须为结构化对象数组 ──────────────────
async def test_userbug2_freshness_reasons_structured(client):
    """概览 freshness.reasons 必须为结构化对象数组（含 kind/label），
    否则前端 FreshnessBanner 取 r.label → undefined（空白内容）、r.kind 命中不了
    PRICE/CASH（无法渲染「去更新行情/现金余额」按钮），只剩「本次会话不再提示」。

    此前后端误将 reasons 返回为纯字符串数组（list[str]），与前端契约
    FreshnessReason{kind,asOf,lagDays,label} 错配。
    """
    creds = await register_login(client, "ub2@example.com", "pw123456")
    h = auth(creds["token"])
    pid = await _create_portfolio(client, h, "UB2组合")
    # 录入持仓但无现价 → 触发 PRICE 维度陈旧（isStale=True）
    await client.post(
        f"/api/portfolios/{pid}/cashflows", headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    await client.post(
        f"/api/portfolios/{pid}/cash-balances", headers=h,
        json={"asOf": str(D1), "amount": 90000},
    )
    sec = (await client.post(
        f"/api/portfolios/{pid}/securities", headers=h,
        json={"code": "600000", "name": "x", "type": "STOCK"},
    )).json()["data"]
    await client.post(
        f"/api/portfolios/{pid}/security-trades", headers=h,
        json={"date": str(D1), "securityId": sec["id"], "side": "BUY_SEC",
              "quantity": 100, "costPrice": 10},
    )
    r = await client.get(f"/api/portfolios/{pid}/overview", headers=h)
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["freshness"]["isStale"] is True
    reasons = data["freshness"]["reasons"]
    assert reasons, "应为陈旧维度产出 reasons"
    # 不再是纯字符串数组：每条必须是含 kind/label 的对象
    assert isinstance(reasons[0], dict)
    assert "kind" in reasons[0] and "label" in reasons[0]
    assert reasons[0]["kind"] in ("PRICE", "CASH")
    assert isinstance(reasons[0]["label"], str) and bool(reasons[0]["label"])
