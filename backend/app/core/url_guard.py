"""SSRF 防护 — 出站 URL 校验（REP-009）。

集中收口所有「服务端代发请求」的 URL 合法性，避免 admin 配置或任务参数
指向 ``file://`` / ``gopher://`` / ``ftp://`` 或云元数据地址（``169.254.169.254``）
造成服务端请求伪造。

- scheme 白名单仅允许 ``http`` / ``https``；
- 默认禁止环回（``localhost`` / ``127.0.0.1`` / ``::1``）与链路本地（``169.254.*``）；
  provider base_url 通常需访问内网，调用方可显式 ``allow_private=True`` 放开。
"""
from __future__ import annotations

from urllib.parse import urlsplit

# 出站请求最大超时（秒），防止恶意/超大 timeout 吊死工作协程。
MAX_HTTP_TIMEOUT: float = 30.0

_ALLOWED_SCHEMES = {"http", "https"}
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_LINK_LOCAL_PREFIX = "169.254."


def assert_safe_url(url: str, *, allow_private: bool = False) -> str:
    """校验出站 URL 合法并返回原值。

    非法 scheme（``file://`` / ``gopher://`` / ``ftp://`` 及无 scheme 的相对路径）
    或（默认）环回/链路本地地址 → 抛 ``ValueError``，阻断 SSRF。

    ``allow_private=True`` 时放行私网/环回（供可信内部 provider 使用）。
    """
    if not url:
        raise ValueError("URL 不能为空")
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise ValueError(
            f"不允许的 URL scheme：{scheme or '(无)'!r}（仅允许 http/https）"
        )
    if not allow_private:
        host = (parts.hostname or "").lower()
        if host in _LOOPBACK_HOSTS or host.startswith(_LINK_LOCAL_PREFIX):
            raise ValueError(f"禁止访问环回/链路本地地址：{host!r}")
    return url


def clamp_timeout(timeout: float | None) -> float:
    """将超时限制在 ``[0, MAX_HTTP_TIMEOUT]``，缺失按上限处理。"""
    if not timeout or timeout <= 0:
        return MAX_HTTP_TIMEOUT
    return min(float(timeout), MAX_HTTP_TIMEOUT)
