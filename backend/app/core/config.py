"""应用配置 — 通过环境变量注入，零遗留替代 NestJS ConfigModule。

对应 app 契约：JWT_SECRET / DATABASE_URL / UPLOAD_DIR / CORS 源 / 注销保留期。
"""
from __future__ import annotations

import logging
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("app.core.config")


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

    # 前端静态托管（Docker 单镜像部署：由后端 serve web/dist）
    # 默认空字符串 = 不托管前端（保持 API-only 形态）；部署时设为 dist 绝对路径
    FRONTEND_DIR: str = ""

    # 可选定时调度器（APScheduler AsyncIOScheduler，数据库驱动，默认开启）。
    # 任务配置存 job_configs 表：普通任务可增删改、系统任务仅可编辑；调度器在应用
    # 启动时从库中加载全部 enabled 任务注册为 cron job，运行时写 job_run_logs 日志。
    SCHEDULER_ENABLED: bool = True

    # 启动期安全配置严格模式（REP-002）。
    # 默认 False：检测到弱密钥/弱默认仅输出 CRITICAL 日志告警，不阻断本地开发流；
    # 设为 1/true：检测到危险配置直接拒绝启动（生产部署推荐开启）。
    STRICT_SECURITY: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()


# ---------------------------------------------------------------------------
# REP-002：启动期安全配置哨兵
# 危险默认值/弱密钥会在启动时告警；设置 STRICT_SECURITY=1 则拒绝启动（生产推荐）。
# ---------------------------------------------------------------------------
_KNOWN_WEAK_JWT_SECRETS = {"change-me-in-prod"}
_MIN_JWT_SECRET_BYTES = 32


def validate_security_config() -> None:
    """启动期安全配置校验（REP-002）。

    检测到以下任一情况时：默认仅输出 CRITICAL 日志（不破坏本地开发流）；
    当环境变量 ``STRICT_SECURITY`` 为真时改为拒绝启动（抛出 RuntimeError）。

    - ``JWT_SECRET`` 仍为默认占位值 ``change-me-in-prod``（任何人可离线伪造任意用户 JWT）；
    - ``JWT_SECRET`` 长度不足 32 字节（存在被暴力破解风险）；
    - ``DATABASE_URL`` 仍为代码内硬编码弱默认（postgres:postgres@localhost，数据库未配置）。
    """
    s = get_settings()
    problems: list[str] = []

    if s.JWT_SECRET in _KNOWN_WEAK_JWT_SECRETS:
        problems.append(
            "JWT_SECRET 仍是默认占位值 'change-me-in-prod'，任何人可离线伪造任意用户 JWT"
        )
    elif len(s.JWT_SECRET.encode("utf-8")) < _MIN_JWT_SECRET_BYTES:
        problems.append(
            f"JWT_SECRET 长度不足 {_MIN_JWT_SECRET_BYTES} 字节，存在被暴力破解风险"
        )

    if s.DATABASE_URL == Settings.model_fields["DATABASE_URL"].default:
        problems.append(
            "DATABASE_URL 仍是代码内硬编码弱默认（postgres:postgres@localhost），数据库未配置"
        )

    if not problems:
        return

    detail = "；".join(problems)
    if s.STRICT_SECURITY:
        logger.critical("安全配置校验失败，拒绝启动：%s", detail)
        raise RuntimeError(f"安全配置校验未通过：{detail}")
    logger.critical(
        "安全配置风险（STRICT_SECURITY 未开启，仅告警不阻断启动）：%s", detail
    )
