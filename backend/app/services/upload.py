"""头像上传 Service — 对齐 app/ 上传能力（§19 附录 B）。

从 routers/upload.py 内联逻辑抽出。负责：类型白名单 + 魔数嗅探（双重校验）、
大小上限、落盘 <UPLOAD_DIR>/avatar/<uuid>.<ext>、更新 user.avatar、best-effort 清旧文件。

注意：本 Service 返回 (user, url)，信封 data 子对象（含手建 user 摘要）由 router 组装。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import User
from app.services.base import PortfolioChildService
from app.storage import StorageService, get_storage_driver

settings = get_settings()

MAX_BYTES = 2 * 1024 * 1024  # 2MB
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}


def _sniff_ext(content: bytes) -> str | None:
    head = content[:12]
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:4] == b"\x89\x50\x4e\x47":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


class UploadService(PortfolioChildService):
    def __init__(
        self, session: AsyncSession, storage: StorageService | None = None
    ) -> None:
        super().__init__(session)
        self.storage = storage or get_storage_driver(get_settings())

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

        url = self.storage.save(content, ext)

        u = (
            await self.session.execute(
                select(User).where(User.id == user_id)
            )
        ).scalar_one()
        old_avatar = u.avatar
        u.avatar = url
        await self.session.commit()
        # 清旧文件（fire-and-forget，经抽象安全闸门）
        self.storage.remove(old_avatar)
        return u, url
