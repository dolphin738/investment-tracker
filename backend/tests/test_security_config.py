"""REP-002：启动期安全配置校验回归测试。

验证 ``validate_security_config``：
- 默认（STRICT_SECURITY 未开）下，弱配置仅告警、绝不抛异常（不破坏 dev/test）；
- STRICT_SECURITY=1 下，弱配置拒绝启动（抛 RuntimeError）；
- 强密钥 + 非默认 DATABASE_URL 时不报错。
"""
from __future__ import annotations

import pytest

from app.core.config import Settings, get_settings, validate_security_config

_DB_DEFAULT = Settings.model_fields["DATABASE_URL"].default
_STRONG_SECRET = "a" * 32  # 32 字节强随机占位
_STRONG_INTERNAL_TOKEN = "b" * 32  # 32 字节强随机占位


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_weak_jwt_default_warns_not_raises(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "change-me-in-prod")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    # 默认模式：弱密钥不应抛异常（仅 CRITICAL 日志）
    validate_security_config()


def test_short_jwt_warns_not_raises(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    validate_security_config()


def test_strict_weak_jwt_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "change-me-in-prod")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_strict_short_jwt_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_strict_db_default_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("DATABASE_URL", _DB_DEFAULT)
    monkeypatch.setenv("STRICT_SECURITY", "1")
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_strong_config_ok(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", _STRONG_INTERNAL_TOKEN)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    # 强配置：默认与严格模式都不应抛异常
    validate_security_config()
    monkeypatch.setenv("STRICT_SECURITY", "1")
    validate_security_config()


def test_internal_token_default_warns_not_raises(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", "change-me-internal")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    # 默认模式：弱内部令牌仅告警，不抛异常
    validate_security_config()


def test_strict_internal_token_default_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@127.0.0.1:5432/db")
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", "change-me-internal")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    with pytest.raises(RuntimeError):
        validate_security_config()
