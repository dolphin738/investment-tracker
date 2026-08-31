"""用户级行情自动同步配置路由。

把行情自动同步改造为每用户独立配置，仅同步该用户自己的组合（仍由 APScheduler
统一调度，见 app/services/scheduler.py 的 user:{user_id} cron job）。

- GET  /api/quote-sync          取当前用户配置（无则返回默认值，不落库）
- PUT  /api/quote-sync          校验并 upsert 当前用户配置，提交后 reload_schedule
- POST /api/quote-sync/trigger  手动立即同步一次当前用户本人组合
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.services.scheduler import reload_schedule, run_user_sync_now
from app.services.auth import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import UserQuoteSyncConfig

_ROUTER_PREFIX = "/api/quote-sync"
# HH:MM（24 小时制）
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_FREQ = ("DAY", "WEEK", "MONTH")


router_quote_sync = APIRouter(
    prefix=_ROUTER_PREFIX, tags=["quote-sync"], route_class=EnvelopeRoute
)


class QuoteSyncUpdate(BaseModel):
    enabled: bool = False
    frequency: str = "DAY"
    time: str = "09:00"
    weekday: int | None = None
    day_of_month: int | None = None


def _validate(body: QuoteSyncUpdate) -> None:
    """校验更新配置（time 格式 / frequency 取值 / WEEK/MONTH 的周期字段），非法 → HTTP 400。"""
    if not _TIME_RE.fullmatch(body.time):
        raise HTTPException(status_code=400, detail="time 格式应为 HH:MM")
    if body.frequency not in _FREQ:
        raise HTTPException(status_code=400, detail="frequency 仅支持 DAY/WEEK/MONTH")
    if body.frequency == "WEEK" and not (1 <= (body.weekday or 0) <= 7):
        raise HTTPException(status_code=400, detail="WEEK 需满足 1<=weekday<=7")
    if body.frequency == "MONTH" and not (1 <= (body.day_of_month or 0) <= 31):
        raise HTTPException(status_code=400, detail="MONTH 需满足 1<=day_of_month<=31")


def _to_dict(cfg: UserQuoteSyncConfig) -> dict:
    return {
        "user_id": cfg.user_id,
        "frequency": cfg.frequency,
        "time": cfg.time,
        "enabled": cfg.enabled,
        "weekday": cfg.weekday,
        "day_of_month": cfg.day_of_month,
        "last_run_at": cfg.last_run_at,
        "last_status": cfg.last_status,
        "last_message": cfg.last_message,
    }


def _default_dict(user_id: str) -> dict:
    """无配置时返回的默认结构（不落库）。"""
    return {
        "user_id": user_id,
        "frequency": "DAY",
        "time": "09:00",
        "enabled": False,
        "weekday": None,
        "day_of_month": None,
        "last_run_at": None,
        "last_status": None,
        "last_message": None,
    }


@router_quote_sync.get("")
async def get_quote_sync(
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    cfg = await db.get(UserQuoteSyncConfig, current.user_id)
    if cfg is None:
        return _default_dict(current.user_id)
    return _to_dict(cfg)


@router_quote_sync.put("")
async def upsert_quote_sync(
    body: QuoteSyncUpdate,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _validate(body)
    cfg = await db.get(UserQuoteSyncConfig, current.user_id)
    if cfg is None:
        cfg = UserQuoteSyncConfig(user_id=current.user_id)
        db.add(cfg)
    cfg.enabled = body.enabled
    cfg.frequency = body.frequency
    cfg.time = body.time
    cfg.weekday = body.weekday
    cfg.day_of_month = body.day_of_month
    await db.commit()
    await db.refresh(cfg)
    await reload_schedule()
    return _to_dict(cfg)


@router_quote_sync.post("/trigger")
async def trigger_quote_sync(
    current: CurrentUser = Depends(get_current_user),
) -> dict:
    run_user_sync_now(current.user_id)
    return {"triggered": True}