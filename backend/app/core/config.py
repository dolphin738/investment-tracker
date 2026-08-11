"""应用配置 — 通过环境变量注入，零遗留替代 NestJS ConfigModule。

对应 app 契约：JWT_SECRET / DATABASE_URL / UPLOAD_DIR / CORS 源 / 注销保留期。
"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # 基础
    PROJECT_NAME: str = "投资收益统计系统 API"
    API_PREFIX: str = "/api"

    # JWT（HS256，与 app 的 passport-jwt 完全兼容）
    JWT_SECRET: str = "change-me-in-prod"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 天

    # 数据库（SQLAlchemy async + asyncpg）
    DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/investment_return_tracker"
    )

    # 测试专用库：与开发库（DATABASE_URL，dev.ps1 / uvicorn 使用）物理隔离。
    # 运行 pytest 时由 conftest 自动 CREATE DATABASE（若不存在）并建表，
    # 避免测试 TRUNCATE 污染开发数据。保持 DATABASE_URL 不变即开发连接不受影响。
    TEST_DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/investment_return_tracker_test"
    )

    # 上传（头像静态资源，URL 前缀必须以 /api 开头，与 vite 代理对齐）
    UPLOAD_DIR: str = "uploads"
    STATIC_ASSETS_PREFIX: str = "/api/uploads"
    # 存储驱动：local（默认）/ cos / s3（预留，尚未实现）；由 storage/factory.py 选择实现
    STORAGE_DRIVER: str = "local"

    # CORS（vite dev server）
    CORS_ORIGINS: list[str] = ["http://localhost:5173"]

    # 账户注销冷静期（天），与 shared ACCOUNT_RETENTION_DAYS 同源
    ACCOUNT_RETENTION_DAYS: int = 30

    # 内部定时清理端点保护令牌：外部 cron（k8s CronJob / 系统 crontab）调用
    # POST /api/internal/cleanup 时携带 X-Internal-Token 头。为空或未匹配则 403。
    # 生产环境必须改为强随机值（对齐「受保护内部端点」）。
    INTERNAL_CLEANUP_TOKEN: str = "change-me-internal"

    # 证券行情 API 基础地址：系统配置项 securities_quote_api_base_url 的回退默认值。
    # 优先读 DB 系统配置；DB 无此配置时回退此处（env SECURITIES_QUOTE_API_BASE_URL），
    # 都没有则用空串（前端按「未配置」处理）。
    SECURITIES_QUOTE_API_BASE_URL: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
