"""FastAPI 应用入口 — 方案B 新项目后端（Python）。

端口 8000；全局前缀 /api；CORS；Swagger /api/docs；静态 /api/uploads；
信封中间件(EnvelopeRoute) + 全局异常处理器(统一信封)；JWT Bearer 鉴权。
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import HTTPException as StarletteHTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.staticfiles import StaticFiles

from app.core.config import get_settings
from app.core.envelope import EnvelopeJSONResponse, EnvelopeRoute
from app.core.exceptions import (
    AccountPendingDeletionException,
    BusinessException,
    business_exception_handler,
    http_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from app.routers import (
    aggregation,
    auth,
    calc,
    data,
    data_transfer,
    dividend,
    health,
    portfolios,
    preference,
    upload,
)

settings = get_settings()

app = FastAPI(
    title=settings.PROJECT_NAME,
    version="1.0",
    description="方案B — 资产快照 + 出入金 + 证券买卖 + 标的最新价 + 现金余额",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url="/api/redoc",
    default_response_class=EnvelopeJSONResponse,
    route_class=EnvelopeRoute,
)

# CORS（与 app 对齐：vite dev 源 + 凭据）
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局异常 → 统一信封
app.add_exception_handler(BusinessException, business_exception_handler)
app.add_exception_handler(
    AccountPendingDeletionException, business_exception_handler
)
app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)

# 头像静态资源挂载（前缀必须含 /api，与全局前缀一致）
_upload_dir = Path(settings.UPLOAD_DIR)
_upload_dir.mkdir(parents=True, exist_ok=True)
app.mount(
    settings.STATIC_ASSETS_PREFIX,
    StaticFiles(directory=str(_upload_dir)),
    name="uploads",
)

app.include_router(health.router)
app.include_router(auth.router)
# ⚠️ aggregation 必须在 portfolios 之前注册：/comparison 字面路由需优先于 /{portfolio_id}
app.include_router(aggregation.router_aggregation)
app.include_router(aggregation.router_account)
app.include_router(portfolios.router)
app.include_router(data.router_cashflows)
app.include_router(data.router_securities)
app.include_router(data.router_trades)
app.include_router(data.router_prices)
app.include_router(data.router_cashbalances)
app.include_router(data.router_snapshots)
app.include_router(dividend.router_dividends)
app.include_router(data_transfer.router_dt_portfolio)
app.include_router(data_transfer.router_dt_global)
app.include_router(preference.router)
app.include_router(upload.router)
app.include_router(calc.router_holdings)
app.include_router(calc.router_xirr)
app.include_router(calc.router_nav)
app.include_router(calc.router_recalculate)


def _custom_openapi() -> dict:
    """在默认 schema 上注入 Bearer 安全定义（对齐 NestJS addBearerAuth）。"""
    if app.openapi_schema:  # type: ignore[attr-defined]
        return app.openapi_schema  # type: ignore[attr-defined]
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema.setdefault("components", {}).setdefault("securitySchemes", {})[
        "JWT-auth"
    ] = {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
    for path in schema.get("paths", {}).values():
        for op in path.values():
            if isinstance(op, dict):
                op["security"] = [{"JWT-auth": []}]
    app.openapi_schema = schema  # type: ignore[attr-defined]
    return app.openapi_schema  # type: ignore[attr-defined]


app.openapi = _custom_openapi  # type: ignore[assignment]
