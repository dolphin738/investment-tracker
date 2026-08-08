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

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy import select

from app.core.config import get_settings
from app.core.envelope import EnvelopeRoute
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import User

settings = get_settings()

MAX_BYTES = 2 * 1024 * 1024  # 2MB
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
PREFIX = settings.STATIC_ASSETS_PREFIX  # /api/uploads
UPLOAD_SUBDIR = "avatar"

# 魔数 → 扩展名
_MAGIC = {
    b"\xff\xd8\xff": "jpg",          # JPEG
    b"\x89\x50\x4e\x47": "png",      # PNG
    b"\x52\x49\x46\x46": "webp",     # RIFF...WEBP（前 4 字节，完整校验在下方）
}


def _sniff_ext(content: bytes) -> str | None:
    head = content[:12]
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:4] == b"\x89\x50\x4e\x47":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _remove_old(avatar_url: str | None) -> None:
    """best-effort 删除旧头像文件（三重校验防穿越）。"""
    if not avatar_url or not avatar_url.startswith(f"{PREFIX}/{UPLOAD_SUBDIR}/"):
        return
    fname = avatar_url.rsplit("/", 1)[-1]
    import re

    if not re.fullmatch(r"[0-9a-f-]{36}\.(jpg|png|webp)", fname):
        return
    base = Path(settings.UPLOAD_DIR)
    target = (base / UPLOAD_SUBDIR / fname).resolve()
    if target != (base / UPLOAD_SUBDIR / fname) and not str(target).startswith(
        str((base / UPLOAD_SUBDIR).resolve())
    ):
        return  # 路径穿越防护
    try:
        os.remove(target)
    except OSError:
        pass  # 失败仅告警


router = APIRouter(prefix="/api/upload", tags=["upload"], route_class=EnvelopeRoute)


@router.post("/avatar")
async def upload_avatar(
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
    file: UploadFile | None = File(None),
):
    if file is None:
        raise BusinessException(
            code=BusinessErrorCode.FILE_INVALID,
            message="缺少文件",
            status_code=400,
        )
    content = await file.read()
    # 大小
    if len(content) > MAX_BYTES:
        raise BusinessException(
            code=BusinessErrorCode.FILE_INVALID,
            message="文件超过 2MB 上限",
            status_code=400,
        )
    # 类型：魔数嗅探（权威）+ MIME 快筛（双重）
    ext = _sniff_ext(content)
    if ext is None or (file.content_type and file.content_type not in ALLOWED_MIME):
        raise BusinessException(
            code=BusinessErrorCode.FILE_INVALID,
            message="仅支持 JPG / PNG / WEBP",
            status_code=400,
        )

    dest_dir = Path(settings.UPLOAD_DIR) / UPLOAD_SUBDIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{uuid.uuid4()}.{ext}"
    (dest_dir / fname).write_bytes(content)

    u = (
        await db.execute(select(User).where(User.id == user.user_id))
    ).scalar_one()
    old_avatar = u.avatar
    url = f"{PREFIX}/{UPLOAD_SUBDIR}/{fname}"
    u.avatar = url
    await db.commit()
    # 清旧文件（fire-and-forget）
    _remove_old(old_avatar)

    return {
        "code": 0,
        "data": {
            "url": url,
            "user": {
                "id": u.id,
                "email": u.email,
                "name": u.name,
                "avatar": u.avatar,
            },
        },
        "message": "ok",
    }
