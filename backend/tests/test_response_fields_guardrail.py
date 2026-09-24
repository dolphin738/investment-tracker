"""护栏 ⑥（方案 §5.1）：旧列名只允许出现在读入口与双写/迁移边界。

旧 4 列（``resp_*_field``）与 ``response_parse.resp_date_field`` 是 P1 Expand 阶段的
**回滚镜像**，读侧必须统一走 ``resolve_fields``。本用例以静态文本扫描守住这条边界，
防止双写期出现散落的旧列直读（「容忍漂移」）。

允许出现的文件（读入口 / 双写 / API 契约透传）：
- ``app/services/response_fields/``（读入口包：旧列合成 + 折叠 / 派生）
- ``app/services/quote_interface.py``（Expand 双写镜像写入）
- ``app/models/quote_interface.py``（列定义本体）
- ``app/modules/admin/schemas.py``（API schema 向后兼容透传：旧 4 列字段声明）
- ``app/modules/admin/quote_router.py``（创建接口端点向 service 透传旧列）

6 个消费点及其余 service 一律不得直接引用旧列名。
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

_APP_DIR = Path(__file__).resolve().parent.parent / "app"

# 旧列语义名的字面量
_LEGACY_TOKENS = (
    "resp_code_field",
    "resp_price_field",
    "resp_name_field",
    "resp_exchange_field",
    "resp_date_field",
)

_ALLOWED = {
    "services/response_fields",
    "services/quote_interface.py",
    "models/quote_interface.py",
    "modules/admin/quote_router.py",
    "modules/admin/schemas.py",
}

# F4「中文列名兜底」token 与各自**允许出现**的文件（D8）。
# 此前护栏只扫 5 个 resp_ 词，对中文兜底列名是空转——QA 变异实测：在 _parse_price_rows
# 注入 ``r.get("代码")`` 后仍 7 passed（GREEN）。此处纳入实际用到的兜底 token。
#
# 采用 **AST 扫描**（``ast.Name`` / ``ast.Attribute`` 标识符 + ``ast.Constant`` 字符串）
# 而非纯文本子串：裸「代码」在十余个文件的中文**注释**里出现，子串扫描会全量误报；
# AST 天然忽略注释，只看真正的代码引用。
#
# 注：``services/response_fields`` 现为一个**包**（原为单文件），故白名单以目录前缀形式
# 表达（见 :func:`_rel_allowed`）；旧列合成逻辑仍只存在于该包内，护栏意图不变。
_FALLBACK_TOKENS: dict[str, set[str]] = {
    # code 槽中文兜底：只允许出现在唯一读入口包（兜底常量定义 + 旧列合成）
    "代码": {"services/response_fields"},
    "_FALLBACK_CODE_FIELD": {"services/response_fields"},
    "_NOTICE_CODE_FIELD": {"services/response_fields"},
    "_COL_NOTICE_CODE": {"services/response_fields"},
    # 公告标题为展示字段（无 slot，§5.2）：取值仅在公告扫描模块，兜底常量在读入口。
    # 公告扫描模块已拆分为 dividend_notice_scan.py（落库主流程）与
    # dividend_notice_meta.py（标题二筛，§6.3），二者均属白名单。
    "公告标题": {
        "services/response_fields",
        "services/dividend_notice_scan.py",
        "services/dividend_notice_meta.py",
    },
    "_COL_NOTICE_TITLE": {
        "services/response_fields",
        "services/dividend_notice_scan.py",
        "services/dividend_notice_meta.py",
    },
}


def _rel_allowed(rel: str, allowed: set[str]) -> bool:
    """``rel`` 是否落在允许集合内——支持 ``services/response_fields`` 这类目录前缀。"""
    return rel in allowed or any(rel == a or rel.startswith(a + "/") for a in allowed)


def _reader_files() -> list[Path]:
    """读入口包内的全部 .py 文件（按 Token 断言用）。"""
    reader_dir = _APP_DIR / "services" / "response_fields"
    return sorted(reader_dir.rglob("*.py"))


def _identifiers_and_strings(path: Path) -> tuple[set[str], set[str]]:
    """AST 提取文件的标识符集合与字符串常量集合（忽略注释，避免误报）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    strings: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            strings.add(node.value)
    return names, strings


def test_legacy_columns_confined_to_allowlist() -> None:
    offenders: list[str] = []
    for path in _APP_DIR.rglob("*.py"):
        rel = path.relative_to(_APP_DIR).as_posix()
        if _rel_allowed(rel, _ALLOWED):
            continue
        text = path.read_text(encoding="utf-8")
        hits = [tok for tok in _LEGACY_TOKENS if tok in text]
        if hits:
            offenders.append(f"{rel}: {', '.join(sorted(hits))}")
    assert not offenders, "旧列名出现于非白名单文件（须改走 resolve_fields）：\n" + "\n".join(
        offenders
    )


def test_chinese_fallback_columns_confined() -> None:
    """F4 中文列名兜底 token 只允许出现在白名单文件（D8 护栏 ⑥ 补强）。"""
    offenders: list[str] = []
    for path in _APP_DIR.rglob("*.py"):
        rel = path.relative_to(_APP_DIR).as_posix()
        names, strings = _identifiers_and_strings(path)
        for token, allowed in _FALLBACK_TOKENS.items():
            pool = names if token.isascii() else strings
            if token in pool and not _rel_allowed(rel, allowed):
                offenders.append(f"{rel}: {token}")
    assert not offenders, (
        "中文列名兜底 token 出现于非白名单文件（须改走 resolve_fields）：\n"
        + "\n".join(sorted(offenders))
    )


def test_allowlist_files_exist() -> None:
    """白名单文件 / 目录必须存在（防止改名后护栏静默失效）。"""
    for rel in _ALLOWED:
        p = _APP_DIR / rel
        if rel.endswith(".py"):
            assert p.exists(), f"白名单文件不存在：{rel}"
        else:
            assert p.is_dir(), f"白名单目录不存在：{rel}"


@pytest.mark.parametrize("token", _LEGACY_TOKENS)
def test_resolve_fields_is_the_reader(token: str) -> None:
    """读入口包确实承载了旧列合成（token 出现在其任一文件内）。"""
    texts = [p.read_text(encoding="utf-8") for p in _reader_files()]
    assert any(token in t for t in texts), f"读入口包未承载旧列 token：{token}"


@pytest.mark.parametrize("token", ["代码", "_FALLBACK_CODE_FIELD", "_NOTICE_CODE_FIELD"])
def test_fallback_code_token_present_in_reader(token: str) -> None:
    """读入口包确实承载中文列名兜底（防 token 被删后护栏静默失效）。"""
    pool: set[str] = set()
    for p in _reader_files():
        names, strings = _identifiers_and_strings(p)
        pool |= names | strings
    assert token in pool
