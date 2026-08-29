"""内部定时清理端点 — 对齐 app/ CleanupService（外部 cron 调用形态，方案 P0-c）。

两个独立端点，分别由外部 cron 按不同频率触发：
- POST /api/internal/cleanup/accounts  账户物理清理（建议每天 04:00，对齐 app @Cron(EVERY_DAY_AT_4AM)）
- POST /api/internal/cleanup/avatars   头像孤儿清理（建议每 3 个月）

两者均受 X-Internal-Token 头保护（独立于用户 JWT，防止任意登录用户触发删库），
幂等，可安全地由外部 cron（k8s CronJob / 系统 crontab / GitHub Actions）重复调用。

部署建议：仅在内部网络暴露，或配合 Ingress/NetworkPolicy 限制来源；生产必须把
INTERNAL_CLEANUP_TOKEN 改为强随机值（默认值仅用于本地开发）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

import secrets

from app.core.config import get_settings
from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.services.cleanup import CleanupService

settings = get_settings()

router = APIRouter(prefix="/api/internal", tags=["internal"], route_class=EnvelopeRoute)


def _assert_internal_token(x_internal_token: str | None) -> None:
    expected = settings.INTERNAL_CLEANUP_TOKEN
    # 空令牌或未携带 → 直接拒绝；再用恒定时间比较防时序侧信道。
    if not expected or x_internal_token is None:
        raise HTTPException(status_code=403, detail="Forbidden: invalid internal token")
    if not secrets.compare_digest(x_internal_token, expected):
        raise HTTPException(status_code=403, detail="Forbidden: invalid internal token")


@router.post("/cleanup/accounts")
async def trigger_account_cleanup(
    x_internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _assert_internal_token(x_internal_token)
    svc = CleanupService(db)
    deleted_users = await svc.physical_purge()
    return {"deletedUsers": deleted_users}


@router.post("/cleanup/avatars")
async def trigger_avatar_cleanup(
    x_internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _assert_internal_token(x_internal_token)
    svc = CleanupService(db)
    removed_avatars = await svc.sweep_orphan_avatars()
    return {"removedAvatars": removed_avatars}
