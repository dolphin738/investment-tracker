"""存储 driver 工厂 — 对齐 app/ modules/upload/upload.module.ts 的 storageServiceFactory。

按 STORAGE_DRIVER 配置选择实现；local 默认，cos/s3 预留分支（暂未实现）。
"""
from __future__ import annotations

from app.core.config import Settings, get_settings
from app.storage.base import StorageService
from app.storage.local_disk import LocalDiskStorage


def get_storage_driver(settings: Settings | None = None) -> StorageService:
    settings = settings or get_settings()
    driver = getattr(settings, "STORAGE_DRIVER", "local")
    if driver == "local":
        return LocalDiskStorage(settings)
    # cos / s3 等对象存储预留分支（保持与 app 可扩展心智一致，暂不实现）
    raise NotImplementedError(
        f"STORAGE_DRIVER={driver!r} 尚未实现（当前仅 'local' 可用）"
    )
