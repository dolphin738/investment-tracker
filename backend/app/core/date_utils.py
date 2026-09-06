"""应用时区工具 — 统一 UTC+8 感知（对齐 app 的 todayInAppTz）。"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

APP_TZ = timezone(timedelta(hours=8))
"""应用时区（UTC+8）— 可导入常量。

调度器（``AsyncIOScheduler`` / ``CronTrigger``）必须显式传它，否则在 TZ=UTC 的
容器里 cron 会被整体推迟 8 小时执行（方案 §6.1 强制项）。
"""

# 兼容旧私有名（历史引用），新代码一律用 ``APP_TZ``
_APP_TZ = APP_TZ


def today_app_tz() -> date:
    """应用当下日期（UTC+8）。重算区间终点默认取它，而非仅当日。"""
    return datetime.now(APP_TZ).date()
