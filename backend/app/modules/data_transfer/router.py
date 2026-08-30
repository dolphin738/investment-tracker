"""数据导入导出路由（§4.2.17）。

- GET  /api/portfolios/{portfolio_id}/export        导出 7 类（文件直出，绕过信封）
- POST /api/portfolios/{portfolio_id}/import/preview 导入预览（不落库，返回 token）
- POST /api/portfolios/{portfolio_id}/import/commit 导入提交（单事务 + 单次重算）
- GET  /api/data-transfer/template                  下载导入模板 3 类（文件直出）

export / template 返回 Response（EnvelopeRoute 透传，不包裹）；
preview / commit 走正常信封。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.services.auth import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import PortfolioSecurity
from app.models.enums import ExportType, ImportType
from app.common import get_portfolio
from app.schemas import ImportCommitReq
from app.schemas_resp import ImportCommitOut, ImportPreviewOut
from app.services import data_transfer as dt


# 类型校验改由 FastAPI 枚举参数（ExportType/ImportType）在边界完成。


def _fmt_ok(format_: str) -> str:
    format_ = (format_ or "csv").lower()
    if format_ not in ("csv", "xlsx"):
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"format 仅支持 csv | xlsx，收到：{format_}",
            status_code=400,
        )
    return format_


# ═══════════════════════════════════════════════════════════════════════════
# 组合域（export / import）
# ═══════════════════════════════════════════════════════════════════════════
router_dt_portfolio = APIRouter(
    prefix="/api/portfolios", tags=["data-transfer"], route_class=EnvelopeRoute
)


@router_dt_portfolio.get("/{portfolio_id}/export")
async def export_data(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    type: ExportType = ExportType.SECURITIES,
    format: str = "csv",
):
    fmt = _fmt_ok(format)
    columns, rows = await dt.build_export(type.value, db, p.id)
    fname = f"{dt.safe_name(p.name)}-{type.value}-{date.today().isoformat()}.{fmt}"
    if fmt == "csv":
        content = dt.to_csv(columns, rows, f"type={type.value} exported by investment-tracker")
        return Response(
            content=content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename={fname}"},
        )
    content = dt.to_xlsx(columns, rows)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


@router_dt_portfolio.post("/{portfolio_id}/import/preview", response_model=ImportPreviewOut)
async def import_preview(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    type: ImportType = Form(...),
    file: UploadFile = File(...),
):
    ext = dt._ext_of(file.filename)
    if ext not in dt.ALLOWED_EXT:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"仅支持 .csv / .xlsx / .xls，收到：{file.filename}",
            status_code=400,
        )
    content = await file.read()
    if len(content) > dt.MAX_FILE_BYTES:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="文件超过 5MB 上限",
            status_code=400,
        )

    header, data = dt._read_sheet(content, ext)
    secs = (
        await db.execute(
            select(PortfolioSecurity)
            .where(PortfolioSecurity.portfolio_id == p.id)
            .options(selectinload(PortfolioSecurity.master))
        )
    ).scalars().all()
    sec_map = {s.master.code: s.id for s in secs if s.master is not None}

    valid_rows, errors, sample, min_date = dt.validate_and_build(
        type.value, header, data, sec_map
    )
    token = dt.make_token(type.value, p.id, valid_rows, min_date)
    return {
        "type": type.value,
        "totalRows": len(data),
        "validRows": len(valid_rows),
        "sample": sample,
        "errors": errors,
        "minDate": min_date,
        "token": token,
    }


@router_dt_portfolio.post("/{portfolio_id}/import/commit", response_model=ImportCommitOut)
async def import_commit(
    req: ImportCommitReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
):
    payload = dt.decode_token(req.token)
    if payload.get("purpose") != "dt_import" or payload.get("type") != req.type.value:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="导入令牌类型不匹配",
            status_code=400,
        )
    if payload.get("portfolio_id") != p.id:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="导入令牌与组合不匹配",
            status_code=400,
        )
    result = await dt.commit_import(
        db, req.type.value, p.id, payload.get("rows", []), payload.get("min_date")
    )
    return result


# ═══════════════════════════════════════════════════════════════════════════
# 全局域（模板，不需要 portfolioId）
# ═══════════════════════════════════════════════════════════════════════════
router_dt_global = APIRouter(
    prefix="/api/data-transfer", tags=["data-transfer"], route_class=EnvelopeRoute
)


@router_dt_global.get("/template")
async def download_template(
    type: ImportType = ImportType.SECURITY_TRADES,
    format: str = "csv",
    _: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    fmt = _fmt_ok(format)
    # 模板列 = 导入列
    from app.services.data_transfer import _FIELD_KIND

    columns = list(_FIELD_KIND[type.value].keys())
    sample = [dt.example_row(type.value)]
    fname = f"template-{type.value}.{fmt}"
    if fmt == "csv":
        content = dt.to_csv(columns, sample, f"template for {type.value}; first row is example")
        return Response(
            content=content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename={fname}"},
        )
    content = dt.to_xlsx(columns, sample)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )
