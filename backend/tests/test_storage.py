"""P1 存储抽象层测试 — 对齐 app/ LocalDiskStorage.canRemove 三重校验。

覆盖：合法 URL 可删、外链 / 路径穿越 / 非 uuid 文件名被拒；save 落盘 + remove 删除；
factory 按 STORAGE_DRIVER 选实现（local 落地，cos/s3 预留分支抛 NotImplementedError）。
"""
from __future__ import annotations

import pytest

from app.core.config import Settings
from app.storage import StorageService, get_storage_driver
from app.storage.local_disk import LocalDiskStorage


def _storage(tmp_path):
    return LocalDiskStorage(
        Settings(UPLOAD_DIR=str(tmp_path), STATIC_ASSETS_PREFIX="/api/uploads")
    )


def test_can_remove_valid():
    s = _storage("/tmp/x")
    assert s.can_remove(
        "/api/uploads/avatar/11111111-1111-1111-1111-111111111111.jpg"
    ) is True


def test_can_remove_external_link():
    s = _storage("/tmp/x")
    assert s.can_remove("http://evil.com/a.png") is False


def test_can_remove_path_traversal():
    s = _storage("/tmp/x")
    assert s.can_remove("/api/uploads/avatar/../../etc/passwd") is False


def test_can_remove_non_uuid_filename():
    s = _storage("/tmp/x")
    assert s.can_remove("/api/uploads/avatar/abc.png") is False


def test_save_writes_file_and_returns_url(tmp_path):
    s = _storage(tmp_path)
    url = s.save(b"img-bytes", "png")
    assert url.startswith("/api/uploads/avatar/")
    fname = url.rsplit("/", 1)[-1]
    assert (tmp_path / "avatar" / fname).exists()
    assert (tmp_path / "avatar" / fname).read_bytes() == b"img-bytes"


def test_remove_deletes_file(tmp_path):
    s = _storage(tmp_path)
    url = s.save(b"x", "jpg")
    fname = url.rsplit("/", 1)[-1]
    s.remove(url)
    assert not (tmp_path / "avatar" / fname).exists()


def test_remove_is_safe_noop(tmp_path):
    """remove 对不存在 / None / 非法 URL 安全跳过（不抛）。"""
    s = _storage(tmp_path)
    s.remove(None)
    s.remove("http://evil.com/a.png")
    s.remove("/api/uploads/avatar/11111111-1111-1111-1111-111111111111.png")  # ENOENT
    assert True  # 到达此处即未抛


def test_factory_local_returns_local_disk():
    s = get_storage_driver(
        Settings(UPLOAD_DIR="/tmp", STORAGE_DRIVER="local")
    )
    assert isinstance(s, LocalDiskStorage)
    assert isinstance(s, StorageService)


def test_factory_unknown_driver_raises():
    with pytest.raises(NotImplementedError):
        get_storage_driver(Settings(UPLOAD_DIR="/tmp", STORAGE_DRIVER="cos"))
