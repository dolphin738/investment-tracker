"""应用时区工具 — 统一 UTC+8 感知（对齐 app 的 todayInAppTz）。"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

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


def parse_date(raw: Any) -> Optional[date]:
    """宽松日期解析（全仓唯一实现，P2-7 收敛）：失败返回 ``None``，不抛异常阻断。

    收敛自两处重复实现，取二者超集：
    - 采集侧 ``dividend_sync._parse_date``：需吃 akshare 的紧凑 ``YYYYMMDD``
      与中文 ``YYYY年MM月DD日``；
    - 导入侧 ``data_transfer._parse_date``：只吃 ISO ``YYYY-MM-DD`` 与 ``YYYY/MM/DD``。

    解析顺序：① ``date.fromisoformat``（Python 3.11+ 亦接受紧凑 YYYYMMDD）→
    ② ``%Y/%m/%d`` 斜杠 → ③ 剥离所有非数字后取前 8 位（覆盖中文与其它分隔符）。
    """
    if raw in (None, "", "-", "nan", "None"):
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:  # ① ISO
        return date.fromisoformat(s)
    except ValueError:
        pass
    try:  # ② 斜杠分隔
        return datetime.strptime(s, "%Y/%m/%d").date()
    except ValueError:
        pass
    digits = re.sub(r"\D", "", s)  # ③ 中文 / 其它分隔
    if len(digits) < 8:
        return None
    try:
        return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
    except (ValueError, TypeError):
        return None
