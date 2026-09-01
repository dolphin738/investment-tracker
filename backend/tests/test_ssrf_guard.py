"""REP-009：SSRF 出站 URL 校验回归测试。

主机校验基于 getaddrinfo + ipaddress 真实 IP 判定：
- 环回 / 链路本地（含云元数据）/ 未指定 / 多播 / 保留段恒为拦截；
- 私网网段默认拦截，``allow_private=True`` 放行；
- 整数主机、IPv4-mapped IPv6 等编码绕过一并拦截。
用例全部使用 IP 字面量 / 保留 TLD，不依赖真实 DNS。
"""
from __future__ import annotations

import pytest

from app.core.url_guard import assert_safe_url, clamp_timeout


@pytest.mark.parametrize(
    "url",
    [
        "https://1.2.3.4/sync",
        "https://93.184.216.34/sync",  # 公网 IP（example.com），不做 DNS 查询
        "http://8.8.4.4:8080/path",
        "HTTP://8.8.4.4/x",  # scheme 大小写不敏感
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
        "http://10.0.0.5:8080/path",  # 私网：默认拦截
        "http://192.168.1.10/x",  # 私网：默认拦截
    ],
)
def test_private_blocked_by_default(url: str):
    with pytest.raises(ValueError):
        assert_safe_url(url)


def test_private_allowed_when_private():
    assert assert_safe_url("http://192.168.1.10:8080/callback", allow_private=True)
    assert assert_safe_url("http://10.0.0.5/x", allow_private=True)


def test_loopback_and_link_local_blocked_even_when_private():
    # 恒为拦截：allow_private=True 也不放行环回 / 链路本地（含云元数据）
    with pytest.raises(ValueError):
        assert_safe_url("http://127.0.0.1:9000/callback", allow_private=True)
    with pytest.raises(ValueError):
        assert_safe_url("http://169.254.169.254/x", allow_private=True)
    with pytest.raises(ValueError):
        assert_safe_url("http://[::ffff:169.254.169.254]/x", allow_private=True)
    with pytest.raises(ValueError):
        assert_safe_url("http://localhost/x", allow_private=True)


def test_integer_host_bypass_blocked():
    # http://2130706433 == http://127.0.0.1（整数编码绕过）
    with pytest.raises(ValueError):
        assert_safe_url("http://2130706433/x", allow_private=True)


def test_unresolvable_host_rejected():
    # .invalid 为保留 TLD，任何环境都不应解析 → 严格路径 fail-secure 拒绝
    with pytest.raises(ValueError):
        assert_safe_url("http://no-such-host-7f3a2b.invalid/x")


def test_unresolvable_host_allowed_when_private():
    # 可信 provider 路径：解析失败放行（请求同样发不出去，无 SSRF 面），
    # 避免「校验期 DNS 抖动误伤合法 provider 配置」
    assert assert_safe_url("http://no-such-host-7f3a2b.invalid/x", allow_private=True)


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
