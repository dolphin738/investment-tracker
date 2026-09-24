"""日志中心辅助函数：CTE 结果组装与 ISO 时间解析。"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from ._models import LogItem


def _build_items(rows: list[dict]) -> list[LogItem]:
    """把 CTE 结果行组装为带前缀 id 的 LogItem 列表。"""
    items: list[LogItem] = []
    for r in rows:
        items.append(
            LogItem(
                id=f"{r['source']}:{r['id']}",
                source=r["source"],
                level=r["level"],
                scope=r["scope"],
                module=r["module"],
                message=r["message"],
                trace=r["trace"],
                detail=r["detail"],
                user_id=r["user_id"],
                created_at=r["created_at"],
                read=r["read"],
            )
        )
    return items


def _parse_dt(v: Optional[str]) -> Optional[datetime]:
    """把 ISO 字符串解析为 datetime，非法输入返回 None（与 list_logs 内解析逻辑一致）。"""
    if not v:
        return None
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None
