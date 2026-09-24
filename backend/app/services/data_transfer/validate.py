"""数据导入导出 —— 逐行校验与预览构造（不落库，签发 token）。"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.core.date_utils import parse_date
from app.models.enums import ImportErrorCode
from app.schemas_resp import ImportRowError

from ._constants import MAX_ROWS, _ENUM_VALUES, _FIELD_KIND, _REQUIRED

__all__ = ["_parse_decimal", "_err", "validate_and_build"]


def _parse_decimal(s: str, max_scale: int = 2) -> Decimal | None:
    """解析十进制字符串；超过 max_scale 位小数视为精度非法返回 None。

    M4：数量/价格为 Numeric(18,6)，默认 2 位约束会误拒碎股/高精度报价；
    调用方按需传入 max_scale（如 quantity/price 用 6）。
    """
    s = (s or "").strip()
    if s == "":
        return None
    try:
        d = Decimal(s)
    except (InvalidOperation, ValueError):
        return None
    if d.as_tuple().exponent < -max_scale:
        return None
    return d


def _err(row, field, code: ImportErrorCode, message) -> ImportRowError:
    return ImportRowError(row=row, field=field, code=code, message=message)


def validate_and_build(
    type_: str,
    header: list[str],
    rows: list[list[str]],
    security_map: dict[str, str],
) -> tuple[list[dict], list[dict], list[dict], str | None]:
    """返回 (valid_rows, errors, sample, min_date_iso)。

    valid_rows：token 用的干净数据（security_id 已解析、date 为 ISO、decimal 为字符串）。
    errors：含全局错误（row=null）与行级错误。
    sample：前 10 行原始字符串样例（列->值）。
    """
    errors: list[ImportRowError] = []
    fields = _FIELD_KIND[type_]
    col_order = list(fields.keys())
    header_lower = {h.lower(): i for i, h in enumerate(header)}
    idx = {col: header_lower.get(col.lower()) for col in col_order}

    # 必需列缺失（全局错误）
    for col in _REQUIRED[type_]:
        if idx[col] is None:
            errors.append(_err(None, col, ImportErrorCode.MISSING_REQUIRED_COLUMN, f"缺少必需列：{col}"))

    # 文件过大
    if len(rows) > MAX_ROWS:
        errors.append(
            _err(None, None, ImportErrorCode.TOO_MANY_ROWS, f"行数超过上限 {MAX_ROWS}")
        )

    valid_rows: list[dict] = []
    seen_snap_dates: dict[str, int] = {}
    for i, r in enumerate(rows, start=1):
        row_errs: list[dict] = []
        parsed: dict = {}
        for col, kind in fields.items():
            pos = idx[col]
            raw = r[pos] if (pos is not None and pos < len(r)) else ""
            if kind == "date":
                d = parse_date(raw)
                if d is None:
                    row_errs.append(_err(i, col, ImportErrorCode.INVALID_DATE_FORMAT, f"{col} 日期格式无效：{raw}"))
                else:
                    parsed[col] = d.isoformat()
            elif kind == "decimal":
                if raw == "" and col not in _REQUIRED[type_]:
                    parsed[col] = None  # 可选列可空
                    continue
                # 金额/费用限 2 位小数；数量/价格放宽到 6 位（Numeric(18,6)）
                max_scale = 6 if col in ("quantity", "costPrice") else 2
                d = _parse_decimal(raw, max_scale=max_scale)
                if d is None:
                    row_errs.append(_err(i, col, ImportErrorCode.INVALID_DECIMAL_PRECISION, f"{col} 数值无效（最多 {max_scale} 位小数）：{raw}"))
                else:
                    parsed[col] = str(d)
            elif kind == "enum":
                if raw not in _ENUM_VALUES[col]:
                    row_errs.append(_err(i, col, ImportErrorCode.INVALID_ENUM_VALUE, f"{col} 取值无效：{raw}"))
                else:
                    parsed[col] = raw
            elif kind == "security":
                sid = security_map.get(raw)
                if sid is None:
                    row_errs.append(_err(i, col, ImportErrorCode.SECURITY_NOT_FOUND, f"标的代码不存在于本组合：{raw}"))
                else:
                    parsed["security_id"] = sid
            else:  # text
                parsed[col] = raw

        # assetSnapshots 重复日期检测
        if type_ == "assetSnapshots" and "date" in parsed:
            d = parsed["date"]
            if d in seen_snap_dates:
                row_errs.append(_err(i, "date", ImportErrorCode.DUPLICATE_SNAPSHOT_DATE, f"同一日期出现多次：{d}"))
            else:
                seen_snap_dates[d] = i

        if not row_errs:
            valid_rows.append(parsed)
        else:
            errors.extend(row_errs)

    # sample：前 10 行原始字符串
    sample = []
    for r in rows[:10]:
        sample.append({col: (r[idx[col]] if (idx[col] is not None and idx[col] < len(r)) else "") for col in col_order})

    min_date = None
    if valid_rows:
        ds = [r["date"] for r in valid_rows if "date" in r]
        if ds:
            min_date = min(ds)

    return valid_rows, errors, sample, min_date
