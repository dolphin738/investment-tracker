"""数据导入导出 —— 文件解析（CSV / XLSX / XLS）。"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime

from openpyxl import load_workbook

__all__ = ["_read_sheet", "_cell_to_str", "_ext_of"]


def _read_sheet(content: bytes, ext: str) -> tuple[list[str], list[list[str]]]:
    """返回 (header, data_rows)。跳过空行与 `#` 开头行。"""
    if ext == ".csv":
        text = content.decode("utf-8-sig")
        raw = [r for r in csv.reader(io.StringIO(text))]
    else:  # xlsx / xls
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        raw = []
        for r in ws.iter_rows(values_only=True):
            raw.append(
                ["" if c is None else (_cell_to_str(c)) for c in r]
            )
    header: list[str] | None = None
    data: list[list[str]] = []
    for r in raw:
        if not any(str(c).strip() for c in r):
            continue
        if str(r[0]).lstrip().startswith("#"):
            continue
        if header is None:
            header = [str(c).strip() for c in r]
        else:
            data.append([str(c).strip() for c in r])
    if header is None:
        header = []
    return header, data


def _cell_to_str(c) -> str:
    if isinstance(c, datetime):
        return c.date().isoformat()
    if isinstance(c, date):
        return c.isoformat()
    return str(c)


def _ext_of(filename: str | None) -> str:
    if not filename:
        return ""
    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
