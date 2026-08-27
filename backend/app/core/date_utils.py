"""应用时区工具 — 统一 UTC+8 感知（对齐 app 的 todayInAppTz）。"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

_APP_TZ = timezone(timedelta(hours=8))


def today_app_tz() -> date:
    """应用当下日期（UTC+8）。重算区间终点默认取它，而非仅当日。"""
    return datetime.now(_APP_TZ).date()
