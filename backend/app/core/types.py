"""共享类型 — 金额 Decimal 字符串化（与 app shared/money.ts 口径一致）。

Prisma Decimal 经 JSON 序列化后是字符串；前端已适配字符串形态。
故 Python 侧一律让 API 输出 string 而非 number，避免金额精度/类型漂移。
DTO 中金额字段统一用 DecimalStr。
"""
from __future__ import annotations

from typing import Annotated

from decimal import Decimal

from pydantic import PlainSerializer, WithJsonSchema


def _decimal_to_str(d: Decimal) -> str:
    return str(d)


# 序列化时为字符串；用 WithJsonSchema 完全覆盖 Pydantic 默认的
# anyOf[number, string-pattern]，使 OpenAPI schema 干净地声明 type:string，
# 前端 openapi-typescript 生成的类型即 string（而非 number | string）。
DecimalStr = Annotated[
    Decimal,
    PlainSerializer(_decimal_to_str, return_type=str, when_used="json"),
    WithJsonSchema({"type": "string", "format": "decimal", "example": "0.00"}),
]
