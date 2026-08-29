"""REP-009：SSRF 出站 URL 校验回归测试。"""
from __future__ import annotations

import pytest

from app.core.url_guard import assert_safe_url, clamp_timeout


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/sync",
        "http://192.168.1.10:8080/path",
        "HTTP://Example.COM/x",  # scheme 大小写不敏感
    ],
)
def test_safe_url_allowed(url: str):
    assert assert_safe_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://127.0.0.1:6379/_",
        "ftp://internal/seed",
        "javascript:alert(1)",
        "/relative/path",  # 无 scheme
        "ftp:/weird",
        "",
    ],
)
def test_unsafe_scheme_rejected(url: str):
    with pytest.raises(ValueError):
        assert_safe_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:9000/callback",
        "http://localhost/health",
        "http://[::1]/x",
        "http://169.254.169.254/latest/meta-data/",
    ],
)
def test_loopback_blocked_by_default(url: str):
    with pytest.raises(ValueError):
        assert_safe_url(url)


def test_loopback_allowed_when_private():
    assert assert_safe_url("http://127.0.0.1:9000/callback", allow_private=True)
    assert assert_safe_url("http://169.254.169.254/x", allow_private=True)


@pytest.mark.parametrize(
    "timeout,expected",
    [
        (None, 30.0),
        (0, 30.0),
        (-5, 30.0),
        (10, 10.0),
        (999, 30.0),  # 上限钳制
        (30, 30.0),
    ],
)
def test_clamp_timeout(timeout, expected):
    assert clamp_timeout(timeout) == expected
