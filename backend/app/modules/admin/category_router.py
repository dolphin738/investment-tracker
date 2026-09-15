"""管理员路由 —— 站内信通知 / 接口分类端点（自 router.py 按职责拆出）。

覆盖原 ``router_admin`` 的中间 6 个端点，内部顺序与原文一致：

- 站内信：``GET /notifications``、``POST /notifications/{notification_id}/read``；
- 接口分类：``GET/POST /interface-categories``、``PATCH/DELETE /interface-categories/{category_id}``。

⚠️ 子 Router 自带 ``prefix`` 与 ``route_class``（``include_router`` 不继承父的 route_class）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.modules.admin.schemas import (
    InterfaceCategoryCreate,
    InterfaceCategoryOut,
    InterfaceCategoryUpdate,
    NotificationOut,
)
from app.services import InterfaceCategoryService
from app.services.auth import CurrentUser, require_admin
from app.services.notification import NotificationService

router_category = APIRouter(prefix="/api/admin", tags=["admin"], route_class=EnvelopeRoute)


@router_category.get("/notifications")
async def list_notifications(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationOut]:
    """站内信列表（按 created_at 倒序）；前端据 read 字段算未读数。"""
    items = await NotificationService(db).list_all()
    return [NotificationOut.model_validate(n) for n in items]


@router_category.post("/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> NotificationOut:
    """标记单条通知为已读（不存在 → 404）。"""
    obj = await NotificationService(db).mark_read(notification_id)
    await db.commit()
    return NotificationOut.model_validate(obj)


# --------------------------------------------------------------------------- #
# 接口分类：列表 / 新增 / 更新 / 删除
# --------------------------------------------------------------------------- #
@router_category.get("/interface-categories")
async def list_interface_categories(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[InterfaceCategoryOut]:
    svc = InterfaceCategoryService(db)
    items = await svc.list()
    # interface_count 非 ORM 属性，from_attributes 校验拿不到：先 model_validate
    # 再逐个回填（计数用一次 group-by 批量取，避免 N+1 查询）
    counts = await svc.counts_by_category()
    out_list: list[InterfaceCategoryOut] = []
    for i in items:
        out = InterfaceCategoryOut.model_validate(i)
        out.interface_count = counts.get(i.id, 0)
        out_list.append(out)
    return out_list


@router_category.post("/interface-categories")
async def create_interface_category(
    body: InterfaceCategoryCreate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> InterfaceCategoryOut:
    svc = InterfaceCategoryService(db)
    # 系统分类同名校验统一在 service 层（单一事实来源，覆盖非 HTTP 调用方）
    cat = await svc.create(
        label=body.label, icon=body.icon, sort_order=body.sort_order
    )
    await db.commit()
    await db.refresh(cat)
    return InterfaceCategoryOut.model_validate(cat)


@router_category.patch("/interface-categories/{category_id}")
async def update_interface_category(
    category_id: str,
    body: InterfaceCategoryUpdate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> InterfaceCategoryOut:
    svc = InterfaceCategoryService(db)
    cat = await svc.get_or_none(category_id)
    if cat is None:
        raise HTTPException(status_code=404, detail="分类不存在")
    cat = await svc.update(
        cat,
        label=body.label,
        icon=body.icon,
        sort_order=body.sort_order,
    )
    await db.commit()
    await db.refresh(cat)
    return InterfaceCategoryOut.model_validate(cat)


@router_category.delete("/interface-categories/{category_id}")
async def delete_interface_category(
    category_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    svc = InterfaceCategoryService(db)
    cat = await svc.get_or_none(category_id)
    if cat is None:
        raise HTTPException(status_code=404, detail="分类不存在")
    # 系统分类不可删除、分类下已配置接口不可删除（有接口的分类返回 400）
    # 的校验统一在 service 层
    await svc.delete(cat)
    await db.commit()
    return {"id": category_id, "deleted": True}
