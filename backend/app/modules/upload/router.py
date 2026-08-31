"""头像上传路由（§19 附录 B）。

POST /api/upload/avatar
- 表单字段 file（唯一 part）
- 类型白名单 image/jpeg|png|webp + 魔数嗅探（双重校验，杜绝伪装）
- 大小上限 2MB
- 落盘 <UPLOAD_DIR>/avatar/<uuid>.<ext>（扩展名由魔数推导，绝不用原名）
- 更新 user.avatar = /api/uploads/avatar/<uuid>.<ext>
- 旧文件 best-effort 删除（失败仅告警，不影响结果）
- 返回手工信封 { code:0, data:{ url, user }, message:"ok" }
- 类型/大小/内容不符/缺失 → 1006（HTTP 400）；未带 token → 401 + 1001（由 get_current_user 保证）
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile

from app.core.envelope import EnvelopeRoute
from app.services.auth import CurrentUser, get_current_user
from app.db.database import get_db
from app.services.upload import UploadService


router = APIRouter(prefix="/api/upload", tags=["upload"], route_class=EnvelopeRoute)


@router.post("/avatar")
async def upload_avatar(
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
    file: UploadFile | None = File(None),
):
    u, url = await UploadService(db).upload_avatar(user.user_id, file)
    return {
        "code": 0,
        "data": {
            "url": url,
            "user": {
                "id": u.id,
                "email": u.email,
                "name": u.name,
                "avatar": u.avatar,
                "role": u.role,
            },
        },
        "message": "ok",
    }
