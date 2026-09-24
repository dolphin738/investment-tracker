"""数据导入导出服务（§4.2.17 · T05 · CSV/XLSX）。

职责：
- 导出 7 类（securities / securityTrades / cashFlows / cashBalances /
  securityPrices / assetSnapshots / navSeries）：CSV（UTF-8 BOM + `#` 注释行）/
  XLSX（openpyxl）。
- 模板 3 类（securityTrades / cashFlows / assetSnapshots）：表头 + 1 行示例。
- 导入预览（不落库）：解析 + 逐行校验（9 种错误码）+ 签发 10 分钟有效 token。
- 导入提交：持 token 在单事务内写入；事务提交后**仅调用 1 次** recalculateNavRange。

Decimal 一律字符串原样读写（不丢精度）。跨组合安全：以路径 portfolio_id 为准，
文件内 portfolioId 列忽略。

本包为「纯位移拆分」：逻辑子模块见 ``_constants`` / ``parse`` / ``validate`` /
``token`` / ``export`` / ``commit``，本文件作为门面，重导出全部原有公开符号
（含路由层 ``from app.services import data_transfer as dt`` 以 ``dt.X`` 形式访问的
``build_export`` / ``safe_name`` / ``to_csv`` / ``to_xlsx`` / ``_ext_of`` /
``ALLOWED_EXT`` / ``MAX_FILE_BYTES`` / ``_read_sheet`` / ``validate_and_build`` /
``make_token`` / ``decode_token`` / ``commit_import`` / ``example_row`` / ``_FIELD_KIND``），
保证 ``from app.services.data_transfer import X`` 与 ``data_transfer.X`` 两种引用
方式均保持不变（零行为变更）。
"""

from __future__ import annotations

from ._constants import (
    ALLOWED_EXT,
    EXPORT_TYPES,
    IMPORT_TYPES,
    MAX_FILE_BYTES,
    MAX_ROWS,
    TOKEN_TTL_MIN,
    _ENUM_VALUES,
    _FIELD_KIND,
    _REQUIRED,
    settings,
)
from .commit import commit_import
from .export import build_export, example_row, safe_name, to_csv, to_xlsx
from .parse import _cell_to_str, _ext_of, _read_sheet
from .token import decode_token, make_token
from .validate import _err, _parse_decimal, validate_and_build

__all__ = [
    # 常量 / 配置
    "MAX_FILE_BYTES", "MAX_ROWS", "TOKEN_TTL_MIN", "ALLOWED_EXT",
    "EXPORT_TYPES", "IMPORT_TYPES", "settings",
    "_FIELD_KIND", "_REQUIRED", "_ENUM_VALUES",
    # 解析
    "_read_sheet", "_cell_to_str", "_ext_of",
    # 校验 / 预览
    "_parse_decimal", "_err", "validate_and_build",
    # token
    "make_token", "decode_token",
    # 导出 / 模板
    "build_export", "example_row", "to_csv", "to_xlsx", "safe_name",
    # 提交
    "commit_import",
]
