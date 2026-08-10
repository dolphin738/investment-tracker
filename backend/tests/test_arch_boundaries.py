"""架构边界测试（纯静态 AST，无需 import-linter 运行时依赖）。

规则：app.services 下的模块**不得直接实例化（构造）其它领域的 ORM 模型**。
即禁止在 service 层出现 `<OtherDomainModel>(` 形式的构造调用；写操作必须经由
对应领域的资源 Service（如 CashflowService）完成，避免与 REST 写入形成双真源。

为什么不用 import-linter 表达：本项目 service 合法依赖自身领域 model（含读查询
`select(Model)` 与构造），import-linter 的模块级 forbidden 契约无法区分「读」与
「构造」，会误伤合法的导出读查询。故此处用 AST 精确只禁「实例化」。

当前受管映射（可按需扩展）：
  app.services.data_transfer 不得直接构造 CashFlow（现金流水写入已收口到 CashflowService）。
"""
from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"

# module -> 禁止其直接实例化的「他域」模型名集合
FORBIDDEN_CONSTRUCTIONS: dict[str, set[str]] = {
    "app.services.data_transfer": {"CashFlow"},
}


def _iter_app_modules():
    for p in APP_ROOT.rglob("*.py"):
        if "__pycache__" in p.parts:
            continue
        rel = p.relative_to(APP_ROOT).with_suffix("")
        module = "app." + ".".join(rel.parts)
        yield module, p


def test_services_do_not_construct_other_domains_orm():
    violations: list[str] = []
    for module, path in _iter_app_modules():
        banned = FORBIDDEN_CONSTRUCTIONS.get(module)
        if not banned:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in banned
            ):
                violations.append(
                    f"{module}:{node.lineno} 直接构造了受管模型 {node.func.id}("
                )
    assert not violations, (
        "发现 service 越界构造其它领域 ORM 模型（双真源风险）：\n"
        + "\n".join(violations)
    )
