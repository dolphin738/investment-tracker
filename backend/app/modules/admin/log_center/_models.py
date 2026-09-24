"""日志中心聚合 API 的请求/响应 schema（Pydantic 模型）。

三源归一后的统一日志条目与分页/删除请求体。端点实现见 ``log_center`` 包 ``__init__.py``。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel


class LogItem(BaseModel):
    """三源归一后的统一日志条目（id 带来源前缀）。"""

    id: str
    source: Literal["app", "notification", "job"]
    level: Optional[str] = None
    scope: Optional[str] = None
    module: Optional[str] = None
    message: Optional[str] = None
    trace: Optional[str] = None
    detail: Optional[Any] = None
    user_id: Optional[str] = None
    created_at: datetime
    read: Optional[bool] = None


class LogListOut(BaseModel):
    """聚合分页结果。"""

    items: list[LogItem]
    total: int
    page: int
    pageSize: int


class LogDeleteBody(BaseModel):
    """删除日志请求体。
    - ids：待删除日志 id 列表（带来源前缀 app:/notif:/job:）；all=False 时必填，可含重复，后端去重。
    - all=True：删除「当前筛选条件下全部日志」（跨所有页），忽略 ids；
      level/scope/module/start/end/keyword 与列表端点一致，用于定位目标集合。
    """

    ids: list[str] = []
    all: bool = False
    level: Optional[str] = None
    scope: Optional[str] = None
    module: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    keyword: Optional[str] = None
