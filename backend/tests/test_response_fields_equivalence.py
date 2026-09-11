"""QA(P1) 独立回归：与改造前(HEAD)行为等价性 + 边界覆盖。

本文件由 QA 独立编写（非工程师产出），用于锁定 P1「行为等价」这一唯一目标：

1. ``test_row_get_matches_head_semantics_matrix``：把 HEAD 版 ``_row_get`` 语义复刻为
   参考实现，对路径 DSL 的向后兼容面做矩阵对账（存量接口只用单段 key / 数字下标）。
2. ``test_compiled_field_get_does_not_parse_path``：边界 14（预编译，行循环零解析）。
3. ``test_category_change_requires_recontract``：边界 10（用途变更且有 response_fields 时重校验）。
4. ``test_validation_400_variants``：key 正则 / source 段数 / scale 三条 400 路径（API 级）。
5-6. 两个 ``xfail``：记录「改造后与 HEAD 潜在不等价」的已知点（见同类 QA 报告），
   置为非严格 xfail，修复后自动转 XPASS 便于发现。

DB 无关用例不依赖 conftest fixtures；API 用例走真实 ASGI app + 测试库。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import update

from app.models import InterfaceCategory, User
from app.services.dividend_sync import _code_of as new_code_of
from app.services.market_data_sync import MarketDataSyncService
from app.services.response_path import row_get
from app.services.response_fields import index_by_slot, resolve_fields
from tests.helpers import auth, env, register_login


# ───────────────────────── HEAD 参考语义 ─────────────────────────
def _head_row_get(row, field):
    """复刻 HEAD 版 market_data_sync._row_get（改造前真相）。"""
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


_MATRIX_ROWS = [
    {"code": "sh600000", "price": "10.5", "name": "浦发银行"},
    {"0": "zero", "1": "one", "2": "two"},
    {"_code": "sz000001"},
    {"代码": "600519", "名称": "贵州茅台"},
    ["600000", "浦发银行", "10.50"],
    ["000001"],
    ("sz000001", "平安银行", "9.90"),
    {"code": None},
    {"secu_code": "sh600000"},
]
_MATRIX_FIELDS = ["code", "代码", "0", "1", "2", "_code", "price", "name",
                  "名称", "secu_code", "symbol"]


def test_row_get_matches_head_semantics_matrix() -> None:
    """存量接口只用单段 key / 数字下标 / _code 时，新 DSL 与 HEAD 逐格一致。"""
    diffs = []
    for row in _MATRIX_ROWS:
        for field in _MATRIX_FIELDS:
            old, new = _head_row_get(row, field), row_get(row, field)
            if old != new:
                diffs.append((row, field, old, new))
    assert diffs == [], f"与 HEAD 不等价的 (row, field, old, new)：{diffs}"


def test_compiled_field_get_does_not_parse_path(monkeypatch) -> None:
    """边界 14：CompiledField.get 在行循环内不得解析路径字符串。"""
    import app.services.response_path as rp

    calls = {"n": 0}
    original = rp.parse_source

    def _counting(source):
        calls["n"] += 1
        return original(source)

    monkeypatch.setattr(rp, "parse_source", _counting)
    rp.compile_source.cache_clear()
    from app.services.response_path import CompiledField

    field = CompiledField(key="c", label=None, slot="code", source="a.b",
                          getter=rp.compile_source("a.b"))
    calls["n"] = 0
    for i in range(500):
        assert field.get({"a": {"b": i}}) == i
    assert calls["n"] == 0


# ───────────────────────── 已知潜在不等价（xfail 记录） ─────────────────────────
@pytest.mark.xfail(
    strict=False,
    reason="P0-1 已知：NOTICE 取码候选顺序与 HEAD 相反（HEAD『代码』优先；"
           "新实现配置列优先）。当前 13 个存量接口未触发，属潜在不等价。",
)
def test_notice_code_candidate_order_matches_head() -> None:
    itf = SimpleNamespace(category_id="4", resp_code_field="code",
                          response_parse={}, response_fields=None)
    row = {"代码": "600519", "code": "999999"}
    compiled = index_by_slot(resolve_fields(itf)).get("code")
    new_value = compiled.get(row) if compiled else None
    assert new_value == "600519"  # HEAD 语义（『代码』优先）


@pytest.mark.xfail(
    strict=False,
    reason="P0-1 已知：用途 3/4 的中文列名兜底外溢到 _prepare_master_rows"
           "（HEAD 主数据准备无该兜底）。当前存量接口数据未触发，属潜在不等价。",
)
def test_master_prepare_no_chinese_fallback_leak_for_dividend() -> None:
    itf = SimpleNamespace(category_id="3", resp_code_field="code",
                          resp_name_field="name", resp_exchange_field=None,
                          response_parse={}, response_fields=None)
    rows = [{"代码": "600519", "名称": "贵州茅台"}]
    assert MarketDataSyncService(None)._prepare_master_rows(itf, rows) == []


@pytest.mark.xfail(
    strict=False,
    reason="P0-1 已知：resp_code_field 为空时，HEAD _code_of 跳过空值只试『代码』；"
           "新实现合成 source='code' 后先试 'code'。当前存量接口无空值，属潜在不等价。",
)
def test_code_of_falsy_resp_code_field_matches_head() -> None:
    """空 resp_code_field 时 _code_of 应只试『代码』（HEAD 语义）。"""
    itf = SimpleNamespace(category_id="3", resp_code_field="",
                          response_parse={}, response_fields=None)
    row = {"code": "X", "代码": "Y"}
    assert new_code_of(itf, row) == "Y"


# ───────────────────────── API：边界 10 / 校验 400 ─────────────────────────
async def _admin(session, client, email: str) -> dict:
    info = await register_login(client, email=email)
    await session.execute(update(User).where(User.email == email).values(role="admin"))
    await session.commit()
    return info


async def _provider(client, token: str) -> str:
    r = await client.post(
        "/api/admin/quote-providers",
        json={"name": "QA源", "access_method": "https",
              "config": {"base_url": "https://x.example.com"}},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    return env(r)[2]["id"]


async def _display_category(client, token: str) -> str:
    r = await client.post(
        "/api/admin/interface-categories", json={"label": "QA展示分类"},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    return env(r)[2]["id"]


async def _create(client, token, pid, **fields):
    body = {"category_id": fields.pop("category_id"), "name": fields.pop("name", "QA接口")}
    body.update(fields)
    return await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces", json=body, headers=auth(token)
    )


@pytest.mark.asyncio
async def test_category_change_requires_recontract(session, client):
    """边界 10：用途变更且已有 response_fields 时必须按新用途重校验。"""
    info = await _admin(session, client, "qa_rf_b10@example.com")
    session.add(InterfaceCategory(id="2", label="证券行情", system=True))
    await session.commit()
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create(client, info["token"], pid, category_id=cid, response_fields=[
        {"key": "code", "slot": "code", "source": "code"}])
    assert env(r)[0] == 200, env(r)
    iid = env(r)[2]["id"]
    r2 = await client.patch(
        f"/api/admin/quote-providers/interfaces/{iid}",
        json={"category_id": "2"}, headers=auth(info["token"]))
    assert env(r2)[0] == 400 and "date" in (env(r2)[3] or ""), env(r2)


@pytest.mark.asyncio
async def test_validation_400_variants(session, client):
    """key 正则非法 / source 段数超限 / scale 越界 各自 400。"""
    info = await _admin(session, client, "qa_rf_v400@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    cases = [
        [{"key": "Bad", "source": "a"}],                             # key 正则
        [{"key": "a", "source": "a.b.c.d.e.f"}],                     # 源段数 6 > 5
        [{"key": "a", "source": "a", "type": "decimal", "scale": 9}],  # scale 越界
        [{"key": "a", "source": "a", "type": "string", "scale": 2}],   # scale 非 decimal
    ]
    for fields in cases:
        r = await _create(client, info["token"], pid, category_id=cid,
                          response_fields=fields)
        assert env(r)[0] == 400, (fields, env(r))
