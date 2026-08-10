"""本地磁盘存储实现 — 对齐 app/ modules/upload/storage/local-disk.storage.ts。

canRemove 三重校验（与 app LocalDiskStorage.canRemove 同源）：
1. URL 以 /api/uploads/avatar/ 前缀；
2. 余部为单一文件名且匹配 <uuid>.<jpg|png|webp> 正则（排除 /、..、查询串）；
3. path.resolve 后仍在 baseDir 内（最终防线，防路径穿越）。
"""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from app.core.config import Settings, get_settings
from app.storage.base import StorageService

ALLOWED_EXT = {"jpg", "png", "webp"}

# 三重校验之「文件名正则」：<uuid>.<ext>
_FNAME_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$",
    re.IGNORECASE,
)


class LocalDiskStorage(StorageService):
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._base = Path(self.settings.UPLOAD_DIR)
        self._allowed = (self._base / "avatar").resolve()
        self._prefix = self.settings.STATIC_ASSETS_PREFIX

    def save(self, content: bytes, ext: str) -> str:
        ext = ext.lower()
        if ext not in ALLOWED_EXT:
            raise ValueError(f"不支持的头像扩展名：{ext}")
        self._allowed.mkdir(parents=True, exist_ok=True)
        fname = f"{uuid.uuid4()}.{ext}"
        (self._allowed / fname).write_bytes(content)
        return f"{self._prefix}/avatar/{fname}"

    def resolve_path(self, url: str) -> Path:
        fname = url.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        return (self._allowed / fname).resolve()

    def can_remove(self, url: str) -> bool:
        if not url or not url.startswith(f"{self._prefix}/avatar/"):
            return False
        fname = url.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        if not _FNAME_RE.match(fname):
            return False
        target = (self._allowed / fname).resolve()
        if target != self._allowed and not str(target).startswith(str(self._allowed)):
            return False
        return True

    def remove(self, url: str | None) -> None:
        if not url or not self.can_remove(url):
            return
        try:
            os.remove(self.resolve_path(url))
        except OSError:
            pass  # 文件不存在 / 被占用：best-effort 跳过
