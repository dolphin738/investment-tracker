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
    # 检测到弱密钥/弱默认时直接拒绝启动（fail-secure，生产与本地均生效；
    # 本地 .env 已配置强 JWT_SECRET，不受影响）。
    STRICT_SECURITY: bool = False

    # 弱密钥逃生阀：仅用于本地快速试验（无 .env 临时起服务）。
    # 设为 1 时弱密钥降级为 CRITICAL 告警、不阻断启动；
    # 但 STRICT_SECURITY=1 恒为阻断，优先级高于本开关。
    ALLOW_WEAK_SECRETS: bool = False

    # 公开注册开关（REP-010）：单用户/内网部署可关闭公开注册（默认开启）。
    REGISTRATION_ENABLED: bool = True

    # 登录失败限速（REP-010）：每 (客户端 IP, 邮箱) 在窗口内的失败次数上限；
    # 默认开启（10 次/分钟）阻断爆破与枚举；0 = 显式关闭（仅限可信内网）。
    LOGIN_RATE_LIMIT_PER_MINUTE: int = 10
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: int = 60

    # 密码最小长度（REP-010）：注册时强制，降低弱口令风险。
    MIN_PASSWORD_LENGTH: int = 8

    # OpenAPI 文档开关（/api/docs、/api/redoc、/api/openapi.json）。
    # 默认开启便于本地开发；生产部署建议 .env 设 0，避免暴露 API 面。
    ENABLE_DOCS: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


# ---------------------------------------------------------------------------
# REP-002：启动期安全配置哨兵
# 弱密钥（JWT_SECRET 占位值/过短、INTERNAL_CLEANUP_TOKEN 占位值）默认拒绝启动
# （fail-secure）；本地临时试验可设 ALLOW_WEAK_SECRETS=1 降级为告警；
# STRICT_SECURITY=1 恒为拒绝启动（同时覆盖 DATABASE_URL 弱默认）。
# ---------------------------------------------------------------------------
_KNOWN_WEAK_JWT_SECRETS = {"change-me-in-prod"}
_MIN_JWT_SECRET_BYTES = 32
_KNOWN_WEAK_INTERNAL_TOKENS = {"change-me-internal"}


def validate_security_config() -> None:
    """启动期安全配置校验（REP-002 / REP-008）。

    检测到以下任一情况时的处理：

    - ``JWT_SECRET`` 仍为默认占位值 ``change-me-in-prod``（任何人可离线伪造任意用户 JWT）
      → **默认拒绝启动**；``ALLOW_WEAK_SECRETS=1`` 时降级为 CRITICAL 告警；
    - ``JWT_SECRET`` 长度不足 32 字节（存在被暴力破解风险）
      → **默认拒绝启动**；``ALLOW_WEAK_SECRETS=1`` 时降级为告警；
    - ``INTERNAL_CLEANUP_TOKEN`` 仍为默认占位值 ``change-me-internal``
      （任何人可触发不可逆物理清理）→ **默认拒绝启动**；``ALLOW_WEAK_SECRETS=1`` 时降级为告警；
    - ``DATABASE_URL`` 仍为代码内硬编码弱默认（postgres:postgres@localhost，数据库未配置）
      → 默认仅告警；``STRICT_SECURITY`` 为真时拒绝启动。

    ``STRICT_SECURITY`` 为真时以上全部问题均拒绝启动（优先级最高）。
    """
    s = get_settings()
    secret_problems: list[str] = []
    other_problems: list[str] = []

    if s.JWT_SECRET in _KNOWN_WEAK_JWT_SECRETS:
        secret_problems.append(
            "JWT_SECRET 仍是默认占位值 'change-me-in-prod'，任何人可离线伪造任意用户 JWT"
        )
    elif len(s.JWT_SECRET.encode("utf-8")) < _MIN_JWT_SECRET_BYTES:
        secret_problems.append(
            f"JWT_SECRET 长度不足 {_MIN_JWT_SECRET_BYTES} 字节，存在被暴力破解风险"
        )

    if s.INTERNAL_CLEANUP_TOKEN in _KNOWN_WEAK_INTERNAL_TOKENS:
        secret_problems.append(
            "INTERNAL_CLEANUP_TOKEN 仍是默认占位值 'change-me-internal'，"
            "任何人可携带默认令牌触发不可逆物理清理"
        )

    if s.DATABASE_URL == Settings.model_fields["DATABASE_URL"].default:
        other_problems.append(
            "DATABASE_URL 仍是代码内硬编码弱默认（postgres:postgres@localhost），数据库未配置"
        )

    # STRICT_SECURITY：所有问题均拒绝启动（fail-secure 总开关，优先级最高）
    if s.STRICT_SECURITY and (secret_problems or other_problems):
        detail = "；".join(secret_problems + other_problems)
        logger.critical("安全配置校验失败，拒绝启动：%s", detail)
        raise RuntimeError(f"安全配置校验未通过：{detail}")

    # 弱密钥：默认拒绝启动；ALLOW_WEAK_SECRETS=1 时降级为告警
    if secret_problems:
        detail = "；".join(secret_problems)
        if s.ALLOW_WEAK_SECRETS:
            logger.critical(
                "安全配置风险（ALLOW_WEAK_SECRETS 已开启，仅告警不阻断启动）：%s", detail
            )
        else:
            logger.critical("安全配置校验失败，拒绝启动：%s", detail)
            raise RuntimeError(f"安全配置校验未通过：{detail}")

    # 其余弱默认（DATABASE_URL）：仅告警
    if other_problems:
        logger.critical(
            "安全配置风险（仅告警不阻断启动，STRICT_SECURITY=1 可拒绝启动）：%s",
            "；".join(other_problems),
        )
