"""数据导入的预览与提交结果（`modules/data_transfer`）。

自 ``app/schemas_resp.py``（495 行、超 §4 的 400 行上限）按域拆出（A11-③）。
**对外唯一导出面仍是 ``app.schemas_resp`` 包**（见该包 ``__init__`` 的显式再导出），
故所有 ``from app.schemas_resp import X`` 与 ``schemas_resp.X`` 引用点无需改动。
拆分是纯位移：字段、类型、默认值与注释逐字保留（护栏：重跑 ``gen_openapi.py``
后 ``docs/openapi.json`` 必须零 diff）。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from pydantic import BaseModel

from app.models.enums import (
    ImportErrorCode,
    ImportType,
)

class ImportRowError(BaseModel):
    """导入行级错误（§4.2.17）。`code` 为 ImportErrorCode 命名枚举。"""

    row: Optional[int] = None
    field: Optional[str] = None
    code: ImportErrorCode
    message: str


class ImportPreviewOut(BaseModel):
    type: ImportType
    totalRows: int
    validRows: int
    sample: list[dict[str, Any]] = []
    errors: list[ImportRowError] = []
    minDate: Optional[date] = None
    token: str


class ImportCommitOut(BaseModel):
    inserted: int
    updated: int
    skipped: int
    failed: list[ImportRowError] = []
    recalculated: Optional[dict[str, Any]] = None
