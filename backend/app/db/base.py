"""SQLAlchemy 声明基类 + 公共混入。

Phase 1：对齐 app/prisma/schema.prisma 方案B 目标态。
- 所有表名使用 snake_case（与 Prisma @@map 一致）。
- 列名 snake_case（与 Prisma @map 一致），无需额外映射。
- created_at / updated_at 由 DB 端 server_default + onupdate 维护。
- 注意：SecurityPrice / CashBalance / DividendRecord 在 Prisma 仅有 createdAt，
  故单独用 CreatedAtMixin（无 updated_at）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, func, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def pk_uuid() -> Mapped[str]:
    """UUID 主键：DB 端 gen_random_uuid() 生成（对齐 Prisma @default(uuid())）。"""
    return mapped_column(
        String(36), primary_key=True, server_default=text("gen_random_uuid()")
    )


class CreatedAtMixin:
    """仅 created_at（对齐 Prisma 仅 @default(now()) 的表）。"""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TimestampMixin(CreatedAtMixin):
    """created_at + updated_at（对齐 Prisma @default(now()) / @updatedAt）。"""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
