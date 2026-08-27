"""路由公共依赖：组合归属隔离、分页。

ORM→dict 序列化已迁至 app/serializers.py（供 service 层复用，避免 service 反向依赖 router）。
"""
from __future__ import annotations

from typing import Callable

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import Portfolio
from app.services.base import paged


async def get_portfolio(
    portfolio_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Portfolio:
    """组合归属隔离：非本人或不存在 → 404（不泄露存在性）。"""
    p = await db.get(Portfolio, portfolio_id)
    if p is None or p.user_id != user.user_id:
        raise BusinessException(
            code=BusinessErrorCode.NOT_FOUND, message="组合不存在", status_code=404
        )
    return p


async def paginate(
    session: AsyncSession,
    stmt,
    page: int,
    page_size: int,
    serializer: Callable,
) -> dict:
    rows, total = await paged(session, stmt, page, page_size)
    return {
        "items": [serializer(r) for r in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
    }
