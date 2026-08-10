"""import-linter 契约测试：把分层/反向依赖边界接入 pytest。

运行依赖 dev 依赖 `import-linter`（已装入 backend/.venv）。
契约定义见 backend/pyproject.toml 的 `[tool.import-linter]`：
  - models 不得反向依赖 services / routers
  - services 不得依赖 routers
若任一契约被破坏，本条测试失败，从而把「架构边界」变成 CI 可拦截的硬约束。

更精细的「service 不得直接构造他域 ORM 模型」由 test_arch_boundaries.py 承担。
"""
from importlinter.api import use_cases


def test_import_linter_contracts_pass():
    # import-linter 2.x：返回 True 表示全部契约通过（失败时打印报告并返回 False）。
    passed = use_cases.lint_imports(config_filename=".importlinter")
    assert passed is True, (
        "import-linter 契约被破坏（架构边界越界）。"
        "运行 `lint-imports` 查看具体违反项（详见 pyproject.toml [tool.import-linter]）。"
    )
