"""接口分类模型 — 后台可配置的接口分类（供证券行情板块下拉读取）。

- key：分类唯一 key（如 ashare_list），UNIQUE 约束。
- label：展示名（如 A股列表）。
- icon：lucide-react 图标名字符串（如 List / LineChart），UI 动态映射渲染。
- sort_order：排序权重（升序）。

接口（QuoteInterface.interface_type）仅存自由文本 key，不强制外键到本表；
删除分类不影响任何接口，UI 无匹配分类时直接显示 raw key。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, pk_uuid


class InterfaceCategory(Base, TimestampMixin):
    __tablename__ = "quote_provider_interface_categories"

    id: Mapped[str] = pk_uuid()
    key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    icon: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
