"""Phase 4 业务模块全量集成测试（v2.3）：dividend / preference / upload / data-transfer。

覆盖 §4.2.16 / §4.2.17 / §4.2.18 / §19 关键契约。
"""
from __future__ import annotations

import pytest

from app.services.recalculation import RecalculationService
from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


# ───────────────────────── dividend §4.2.18 ─────────────────────────
async def _seed_security(client, h, pid, code="600000", name="浦发银行"):
    st, code_, data, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/securities",
            headers=h,
            json={"code": code, "name": name, "type": "STOCK", "currency": "CNY"},
        )
    )
    assert st == 200 and code_ == 0, (st, code_, msg)
    return data["id"]


async def test_dividend_crud_and_netamount(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]
    sid = await _seed_security(client, h, pid)

    # 创建：amount=100, tax=20 → netAmount=80
    st, code, d, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/dividends",
            headers=h,
            json={"securityId": sid, "date": "2024-06-01", "amount": "100", "tax": "20", "type": "CASH"},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert d["securityCode"] == "600000"
    assert d["amount"] == "100.00"
    assert d["tax"] == "20.00"
    assert d["netAmount"] == "80.00"
    div_id = d["id"]

    # 列表 + 过滤
    st, code, lst, msg = env(
        await client.get(f"/api/portfolios/{pid}/dividends", headers=h)
    )
    assert st == 200 and code == 0 and lst["total"] == 1

    # 多值 securityId 过滤
    st, code, lst, msg = env(
        await client.get(
            f"/api/portfolios/{pid}/dividends?securityId={sid}", headers=h
        )
    )
    assert lst["total"] == 1

    # 改 tax → netAmount 重算
    st, code, d, msg = env(
        await client.patch(
            f"/api/portfolios/{pid}/dividends/{div_id}",
            headers=h,
            json={"tax": "30"},
        )
    )
    assert d["netAmount"] == "70.00"

    # 删除
    st, code, d, msg = env(
        await client.delete(f"/api/portfolios/{pid}/dividends/{div_id}", headers=h)
    )
    assert st == 200 and code == 0
    st, code, lst, msg = env(
        await client.get(f"/api/portfolios/{pid}/dividends", headers=h)
    )
    assert lst["total"] == 0


async def test_dividend_negative_net_rejected(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]
    sid = await _seed_security(client, h, pid)
    st, code, d, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/dividends",
            headers=h,
            json={"securityId": sid, "date": "2024-06-01", "amount": "10", "tax": "30"},
        )
    )
    assert st == 400 and code == 2000, (st, code, msg)


async def test_dividend_secondary_isolation(client):
    u = await register_login(client)
    h = auth(u["token"])
    p1 = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    p2 = (await client.post("/api/portfolios", headers=h, json={"name": "P2"})).json()["data"]
    sid2 = await _seed_security(client, h, p2["id"])  # 属于 P2
    # 用 P2 的标的挂到 P1 → 404
    st, code, d, msg = env(
        await client.post(
            f"/api/portfolios/{p1['id']}/dividends",
            headers=h,
            json={"securityId": sid2, "date": "2024-06-01", "amount": "10"},
        )
    )
    assert st == 404 and code == 3001, (st, code, msg)


# ───────────────────────── preference §4.2.16 ─────────────────────────
async def test_preference_get_default_and_patch(client):
    u = await register_login(client)
    h = auth(u["token"])
    st, code, pref, msg = env(await client.get("/api/users/preferences", headers=h))
    assert st == 200 and code == 0, (st, code, msg)
    assert pref["theme"] == "system"
    assert pref["staleDays"] == 3
    assert pref["defaultDateRange"] == "1y"

    # 合法更新
    st, code, pref, msg = env(
        await client.patch(
            "/api/users/preferences", headers=h, json={"theme": "dark", "defaultDateRange": "all"}
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert pref["theme"] == "dark"
    assert pref["defaultDateRange"] == "all"

    # 非法 defaultDateRange → 400
    st, code, pref, msg = env(
        await client.patch(
            "/api/users/preferences", headers=h, json={"defaultDateRange": "bad"}
        )
    )
    assert st == 400 and code == 2000, (st, code, msg)

    # 未知字段 → 400
    st, code, pref, msg = env(
        await client.patch("/api/users/preferences", headers=h, json={"foo": 1})
    )
    assert st == 400 and code == 2000, (st, code, msg)


# ───────────────────────── upload §19 ─────────────────────────
PNG_SIG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
PDF_BYTES = b"%PDF-1.4 fake content not an image"


async def test_upload_avatar_success(client):
    u = await register_login(client)
    h = auth(u["token"])
    st, code, body, msg = env(
        await client.post(
            "/api/upload/avatar",
            headers=h,
            files={"file": ("a.png", PNG_SIG, "image/png")},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    # 手工信封：env 已抽出 data（url + user）
    assert body["url"].startswith("/api/uploads/avatar/")
    assert body["user"]["avatar"] == body["url"]
    # 清理落盘文件
    import os
    from app.core.config import get_settings

    settings = get_settings()
    fpath = os.path.join(settings.UPLOAD_DIR, body["url"].split("/")[-1])
    if os.path.exists(fpath):
        os.remove(fpath)


async def test_upload_avatar_rejects_fake_type(client):
    u = await register_login(client)
    h = auth(u["token"])
    # pdf 字节伪装成 png
    st, code, body, msg = env(
        await client.post(
            "/api/upload/avatar",
            headers=h,
            files={"file": ("evil.png", PDF_BYTES, "image/png")},
        )
    )
    assert st == 400 and code == 1006, (st, code, msg)


# ───────────────────────── data-transfer §4.2.17 ─────────────────────────
async def test_export_securities_csv(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P 导出"})).json()["data"]
    pid = p["id"]
    await _seed_security(client, h, pid, code="000001", name="平安银行")
    resp = await client.get(
        f"/api/portfolios/{pid}/export?type=securities&format=csv", headers=h
    )
    assert resp.status_code == 200
    # 绕过信封：直接是文件内容（BOM + header）
    body = resp.content
    assert body[:3] == b"\xef\xbb\xbf"  # UTF-8 BOM
    text = body.decode("utf-8-sig")
    assert text.startswith("code,name,type,currency")
    assert "000001" in text


async def test_template_securitytrades_csv(client):
    u = await register_login(client)
    h = auth(u["token"])
    resp = await client.get(
        "/api/data-transfer/template?type=securityTrades&format=csv", headers=h
    )
    assert resp.status_code == 200
    text = resp.content.decode("utf-8-sig")
    assert text.startswith("date,securityCode,side,quantity,costPrice,feeTotal,note")
    # 第二行是 # 注释
    lines = text.splitlines()
    assert lines[1].startswith("#")


async def test_import_cashflows_preview_commit_single_recalc(client, monkeypatch):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]

    csv_content = "date,type,amount,note\n2024-03-01,BUY,100000.00,入金\n"
    # preview
    st, code, prev, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/import/preview",
            headers=h,
            data={"type": "cashFlows"},
            files={"file": ("cf.csv", csv_content.encode("utf-8-sig"), "text/csv")},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert prev["validRows"] == 1
    assert prev["errors"] == []
    token = prev["token"]

    # 监视单次重算
    calls = []
    orig = RecalculationService.recalculateNavRange

    async def spy(self, *a, **k):
        calls.append(1)
        return await orig(self, *a, **k)

    monkeypatch.setattr(RecalculationService, "recalculateNavRange", spy)

    # commit
    st, code, res, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/import/commit",
            headers=h,
            json={"type": "cashFlows", "token": token},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert res["inserted"] == 1
    assert res["recalculated"] is not None
    assert len(calls) == 1, f"重算应仅调用 1 次，实际 {len(calls)}"

    # 落库校验
    st, code, lst, msg = env(
        await client.get(f"/api/portfolios/{pid}/cashflows", headers=h)
    )
    assert lst["total"] == 1


async def test_import_preview_row_errors(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]
    csv_content = "date,type,amount,note\nbad-date,BUY,100,错\n"
    st, code, prev, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/import/preview",
            headers=h,
            data={"type": "cashFlows"},
            files={"file": ("cf.csv", csv_content.encode("utf-8"), "text/csv")},
        )
    )
    assert st == 200 and code == 0
    assert prev["validRows"] == 0
    codes = {e["code"] for e in prev["errors"]}
    assert "INVALID_DATE_FORMAT" in codes


async def test_import_securitytrades_and_snapshots(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]
    sid = await _seed_security(client, h, pid, code="600519", name="贵州茅台")

    # trades 导入
    csv_t = f"date,securityCode,side,quantity,costPrice,feeTotal,note\n2024-04-01,600519,BUY_SEC,10,100.5,0,建仓\n"
    prev = (await client.post(
        f"/api/portfolios/{pid}/import/preview",
        headers=h, data={"type": "securityTrades"},
        files={"file": ("t.csv", csv_t.encode("utf-8-sig"), "text/csv")},
    )).json()["data"]
    assert prev["validRows"] == 1, prev
    (await client.post(
        f"/api/portfolios/{pid}/import/commit",
        headers=h, json={"type": "securityTrades", "token": prev["token"]},
    ))
    st, code, lst, msg = env(
        await client.get(f"/api/portfolios/{pid}/security-trades", headers=h)
    )
    assert lst["total"] == 1

    # 先导入一笔 BUY 入金（计算引擎要求首日期有入金，否则 NAV 递推抛错）
    csv_cf = "date,type,amount,note\n2024-04-01,BUY,100000.00,入金\n"
    prev_cf = (await client.post(
        f"/api/portfolios/{pid}/import/preview",
        headers=h, data={"type": "cashFlows"},
        files={"file": ("cf.csv", csv_cf.encode("utf-8-sig"), "text/csv")},
    )).json()["data"]
    assert prev_cf["validRows"] == 1, prev_cf
    (await client.post(
        f"/api/portfolios/{pid}/import/commit",
        headers=h, json={"type": "cashFlows", "token": prev_cf["token"]},
    ))

    # snapshots 导入（MANUAL）
    csv_s = "date,totalAsset,marketValue,cashBalance,note\n2024-04-01,200000.00,1000.00,199000.00,手动\n"
    prev2 = (await client.post(
        f"/api/portfolios/{pid}/import/preview",
        headers=h, data={"type": "assetSnapshots"},
        files={"file": ("s.csv", csv_s.encode("utf-8-sig"), "text/csv")},
    )).json()["data"]
    assert prev2["validRows"] == 1, prev2
    (await client.post(
        f"/api/portfolios/{pid}/import/commit",
        headers=h, json={"type": "assetSnapshots", "token": prev2["token"]},
    ))
    st, code, snap, msg = env(
        await client.get(f"/api/portfolios/{pid}/snapshots/2024-04-01", headers=h)
    )
    assert st == 200 and code == 0
    assert snap["source"] == "MANUAL"
    assert snap["totalAsset"] == "200000.00"
