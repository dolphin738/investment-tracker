"""REP-002：启动期安全配置校验回归测试。

验证 ``validate_security_config``：
- 弱密钥（JWT_SECRET 占位/过短、INTERNAL_CLEANUP_TOKEN 占位）**默认拒绝启动**（fail-secure）；
- ALLOW_WEAK_SECRETS=1 时弱密钥降级为告警、不抛异常（本地逃生阀）；
- STRICT_SECURITY=1 恒为拒绝启动（优先级高于 ALLOW_WEAK_SECRETS）；
- DATABASE_URL 弱默认：默认仅告警，STRICT_SECURITY=1 时拒绝启动；
- 强密钥 + 非默认 DATABASE_URL 时不报错。
"""
from __future__ import annotations

import pytest

from app.core.config import Settings, get_settings, validate_security_config

_DB_DEFAULT = Settings.model_fields["DATABASE_URL"].default
_DB_OK = "postgresql+asyncpg://u:p@127.0.0.1:5432/db"
_STRONG_SECRET = "a" * 32  # 32 字节强随机占位
_STRONG_INTERNAL_TOKEN = "b" * 32  # 32 字节强随机占位


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_weak_jwt_default_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "change-me-in-prod")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.delenv("ALLOW_WEAK_SECRETS", raising=False)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_short_jwt_default_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.delenv("ALLOW_WEAK_SECRETS", raising=False)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_weak_jwt_allowed_with_escape_hatch(monkeypatch):
    # 本地逃生阀：ALLOW_WEAK_SECRETS=1 时弱密钥仅告警，不抛异常
    monkeypatch.setenv("JWT_SECRET", "change-me-in-prod")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.setenv("ALLOW_WEAK_SECRETS", "1")
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    validate_security_config()


def test_strict_overrides_escape_hatch(monkeypatch):
    # STRICT_SECURITY 优先级最高：即使 ALLOW_WEAK_SECRETS=1 也拒绝启动
    monkeypatch.setenv("JWT_SECRET", "change-me-in-prod")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    monkeypatch.setenv("ALLOW_WEAK_SECRETS", "1")
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_strict_weak_jwt_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "change-me-in-prod")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    monkeypatch.delenv("ALLOW_WEAK_SECRETS", raising=False)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_strict_short_jwt_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    monkeypatch.delenv("ALLOW_WEAK_SECRETS", raising=False)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_db_default_warns_by_default(monkeypatch):
    # DATABASE_URL 弱默认：默认仅告警，不抛异常
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", _STRONG_INTERNAL_TOKEN)
    monkeypatch.setenv("DATABASE_URL", _DB_DEFAULT)
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
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
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.delenv("ALLOW_WEAK_SECRETS", raising=False)
    # 强配置：默认与严格模式都不应抛异常
    validate_security_config()
    monkeypatch.setenv("STRICT_SECURITY", "1")
    validate_security_config()


def test_internal_token_default_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", "change-me-internal")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.delenv("ALLOW_WEAK_SECRETS", raising=False)
    with pytest.raises(RuntimeError):
        validate_security_config()


def test_internal_token_escape_hatch_warns(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", "change-me-internal")
    monkeypatch.delenv("STRICT_SECURITY", raising=False)
    monkeypatch.setenv("ALLOW_WEAK_SECRETS", "1")
    validate_security_config()


def test_strict_internal_token_default_rejects(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", _STRONG_SECRET)
    monkeypatch.setenv("DATABASE_URL", _DB_OK)
    monkeypatch.setenv("INTERNAL_CLEANUP_TOKEN", "change-me-internal")
    monkeypatch.setenv("STRICT_SECURITY", "1")
    with pytest.raises(RuntimeError):
        validate_security_config()
