"""存储抽象 — 对齐 app/ modules/upload/storage/storage.service.ts 的抽象 StorageService。

定义统一存储契约，使业务（UploadService）仅依赖抽象，不关心底层是本地磁盘还是
对象存储（COS/S3）。driver 选择由 storage/factory.py 按 STORAGE_DRIVER 配置决定。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path


class StorageService(ABC):
    @abstractmethod
    def save(self, content: bytes, ext: str) -> str:
        """落盘并返回可访问 URL（如 /api/uploads/avatar/<uuid>.<ext>）。"""

    @abstractmethod
    def remove(self, url: str | None) -> None:
        """删除 URL 指向的文件；URL 不合法 / 不存在 / 非本驱动文件 → 安全跳过。"""

    @abstractmethod
    def can_remove(self, url: str) -> bool:
        """是否允许删除（安全闸门：前缀 + 文件名正则 + resolve 在 baseDir 内）。"""

    @abstractmethod
    def resolve_path(self, url: str) -> Path:
        """URL → 绝对路径（供 remove 内部使用）。"""
