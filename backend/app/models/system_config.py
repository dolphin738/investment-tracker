"""系统配置表 — 集中存储运营可调的键值型配置（如证券行情 API 地址）。

设计为通用键值存储：key 唯一、config_value 为 JSONB（结构化值）、description 备注、
updated_by 记录最后修改人（审计）。读多写少，由 admin 路由受角色保护后写入。
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, pk_uuid


class SystemConfig(Base, TimestampMixin):
    __tablename__ = "system_configs"

    id: Mapped[str] = pk_uuid()
    key: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    config_value: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
