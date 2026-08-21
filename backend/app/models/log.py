"""统一日志中心 — 运行错误 / 业务操作日志持久化（方案 §4.1）。

全站各模块的关键失败点与全局 5xx 异常统一写入 ``app_logs``：
- ``level``：error | warning | info（默认 info）。
- ``scope``：error=运行错误 / operation=业务操作 / system=系统（默认 operation）。
- ``module``：来源模块名（如 api / auth / scheduler）。
- ``message``：日志消息。
- ``trace``：可空，异常堆栈（5xx 落库时填）。
- ``detail``：可空，结构化附加信息（JSON）。
- ``user_id``：可空，关联用户 id（先只存 id，不建外键，规避软删除 / 级联纠缠）。
- ``created_at``：由 ``CreatedAtMixin`` 提供。

与 ``notifications`` / ``job_run_logs`` 保持同风格：UUID 主键、String(36)、server_default
gen_random_uuid()、created_at 用 Python 端默认 + DB 兜底（避免 async 惰性加载 MissingGreenlet）。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, pk_uuid


class AppLog(Base, CreatedAtMixin):
    __tablename__ = "app_logs"

    id: Mapped[str] = pk_uuid()
    level: Mapped[str] = mapped_column(
        String(20), nullable=False, default="info", server_default="info"
    )
    scope: Mapped[str] = mapped_column(
        String(20), nullable=False, default="operation", server_default="operation"
    )
    module: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    trace: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
