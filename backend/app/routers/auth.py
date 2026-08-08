"""认证路由 — 对齐 docs/ARCHITECTURE.md §4.2.1。

公开：register / login / account/restore。受保护：me / profile。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import User
from app.schemas import LoginReq, ProfilePatchReq, RegisterReq, RestoreReq
from app.services.user import UserService

router = APIRouter(prefix="/api/auth", tags=["auth"], route_class=EnvelopeRoute)


@router.post("/register")
async def register(req: RegisterReq, db: AsyncSession = Depends(get_db)) -> dict:
    user = await UserService(db).register(req.email, req.password, req.name)
    return {"id": user.id, "email": user.email, "name": user.name}


@router.post("/login")
async def login(req: LoginReq, db: AsyncSession = Depends(get_db)) -> dict:
    user = await UserService(db).authenticate(req.email, req.password)
    token = UserService.issue_token(user)
    return {
        "accessToken": token,
        "user": {"id": user.id, "email": user.email, "name": user.name},
    }


@router.post("/account/restore")
async def restore(req: RestoreReq, db: AsyncSession = Depends(get_db)) -> dict:
    user = await UserService(db).restore(req.email, req.password)
    token = UserService.issue_token(user)
    return {
        "accessToken": token,
        "user": {"id": user.id, "email": user.email, "name": user.name},
    }


@router.get("/me")
async def me(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    u = (
        await db.execute(select(User).where(User.id == user.user_id))
    ).scalar_one()
    return {"id": u.id, "email": u.email, "name": u.name}


@router.patch("/profile")
async def profile(
    req: ProfilePatchReq,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    u = (
        await db.execute(select(User).where(User.id == user.user_id))
    ).scalar_one()
    if req.name is not None:
        u.name = req.name
    if req.avatar is not None:
        u.avatar = req.avatar
    await db.commit()
    return {"id": u.id, "email": u.email, "name": u.name, "avatar": u.avatar}
