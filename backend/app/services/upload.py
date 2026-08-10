"""头像上传 Service — 对齐 app/ 上传能力（§19 附录 B）。

从 routers/upload.py 内联逻辑抽出。负责：类型白名单 + 魔数嗅探（双重校验）、
大小上限、落盘 <UPLOAD_DIR>/avatar/<uuid>.<ext>、更新 user.avatar、best-effort 清旧文件。

注意：本 Service 返回 (user, url)，信封 data 子对象（含手建 user 摘要）由 router 组装。
"""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import User
from app.services.base import PortfolioChildService

settings = get_settings()

MAX_BYTES = 2 * 1024 * 1024  # 2MB
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
PREFIX = settings.STATIC_ASSETS_PREFIX  # /api/uploads
UPLOAD_SUBDIR = "avatar"


def _sniff_ext(content: bytes) -> str | None:
    head = content[:12]
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:4] == b"\x89\x50\x4e\x47":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _remove_old(avatar_value: str | None) -> None:
    """best-effort 删除旧头像文件（兼容完整 URL / 绝对路径 / 不同前缀；防穿越）。"""
    if not avatar_value:
        return
    fname = avatar_value.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if not re.fullmatch(r"[0-9a-f-]{36}\.(jpg|png|webp)", fname):
        return
    base = Path(settings.UPLOAD_DIR)
    allowed = (base / UPLOAD_SUBDIR).resolve()
    target = (allowed / fname).resolve()
    if target != allowed and not str(target).startswith(str(allowed)):
        return  # 路径穿越防护
    try:
        os.remove(target)
    except OSError:
        pass  # 失败仅告警


class UploadService(PortfolioChildService):
    async def upload_avatar(
        self, user_id: str, file
    ) -> tuple[User, str]:
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
        if ext is None or (
            file.content_type and file.content_type not in ALLOWED_MIME
        ):
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
            await self.session.execute(
                select(User).where(User.id == user_id)
            )
        ).scalar_one()
        old_avatar = u.avatar
        url = f"{PREFIX}/{UPLOAD_SUBDIR}/{fname}"
        u.avatar = url
        await self.session.commit()
        # 清旧文件（fire-and-forget）
        _remove_old(old_avatar)
        return u, url
