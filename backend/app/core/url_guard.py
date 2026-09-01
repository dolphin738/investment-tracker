"""SSRF 防护 — 出站 URL 校验（REP-009）。

集中收口所有「服务端代发请求」的 URL 合法性，避免 admin 配置或任务参数
指向 ``file://`` / ``gopher://`` / ``ftp://`` 或云元数据地址（``169.254.169.254``）
造成服务端请求伪造。

- scheme 白名单仅允许 ``http`` / ``https``；
- 主机经 ``socket.getaddrinfo`` 解析为全部 IP 后逐一判定，杜绝
  整数/十六进制主机（``http://2130706433``）、IPv4-mapped IPv6
  （``[::ffff:169.254.169.254]``）等字符串前缀匹配绕过；
- 环回（loopback）、链路本地（169.254.0.0/16，含云元数据）、未指定地址、
  多播与保留段**恒为拦截**（``allow_private=True`` 也不放行）；
- 私网网段（10/172.16-31/192.168、IPv6 fc00::/7 等）默认拦截，
  provider base_url 通常需访问内网，调用方可显式 ``allow_private=True`` 放行；
- 主机名无法解析时 fail-secure：直接拒绝。
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

# 出站请求最大超时（秒），防止恶意/超大 timeout 吊死工作协程。
MAX_HTTP_TIMEOUT: float = 30.0

_ALLOWED_SCHEMES = {"http", "https"}


def _resolve_ips(host: str) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """将主机名解析为规范化 IP 集合。

    IP 字面量直接解析（不发 DNS 查询）；IPv4-mapped IPv6 还原为 IPv4 判定。
    DNS 解析失败抛 ``OSError``；地址非法抛 ``ValueError``。
    """
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        addr = None
    if addr is not None:
        return {addr}

    # 宽松数值主机（inet_aton 语义）：2130706433 / 127.1 / 0x7f.1.2.3 等，
    # Windows getaddrinfo 不认这些形式，须显式归一为 IPv4 再判定
    try:
        return {ipaddress.ip_address(socket.inet_aton(host))}
    except (OSError, ValueError):
        pass

    infos = socket.getaddrinfo(host, None)  # 失败抛 OSError（由调用方定策略）
    if not infos:
        raise OSError(f"主机名 {host!r} 无解析记录")

    ips: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError as exc:
            raise ValueError(f"主机名 {host!r} 解析出非法地址：{info[4][0]!r}") from exc
        # ::ffff:a.b.c.d 还原为 IPv4，按 IPv4 规则判定（防 mapped 绕过）
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        ips.add(ip)
    return ips


def assert_safe_url(url: str, *, allow_private: bool = False) -> str:
    """校验出站 URL 合法并返回原值。

    非法 scheme（``file://`` / ``gopher://`` / ``ftp://`` 及无 scheme 的相对路径）、
    环回/链路本地地址（恒拦）、私网地址（默认拦，``allow_private=True`` 放行）
    → 抛 ``ValueError``，阻断 SSRF。

    DNS 解析失败时的策略：严格路径（``allow_private=False``）fail-secure 拒绝；
    可信 provider 路径（``allow_private=True``）放行——不可解析的域名发不出
    请求，无 SSRF 面，避免「校验期 DNS 抖动误伤合法 provider 配置」。
    """
    if not url:
        raise ValueError("URL 不能为空")
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise ValueError(
            f"不允许的 URL scheme：{scheme or '(无)'!r}（仅允许 http/https）"
        )
    host = (parts.hostname or "").lower()
    if not host:
        raise ValueError("URL 缺少主机名")

    try:
        ips = _resolve_ips(host)
    except OSError as exc:
        if allow_private:
            return url
        raise ValueError(f"无法解析主机名：{host!r}（{exc}）") from exc

    for ip in ips:
        # 恒为拦截：环回 / 链路本地（含云元数据 169.254.169.254）/ 未指定 / 多播 / 保留
        if (
            ip.is_loopback
            or ip.is_link_local
            or ip.is_unspecified
            or ip.is_multicast
            or ip.is_reserved
        ):
            raise ValueError(f"禁止访问受限地址：{host!r} → {ip}")
        # 默认拦截私网网段；allow_private=True 时放行
        if not allow_private and ip.is_private:
            raise ValueError(f"禁止访问私网地址：{host!r} → {ip}")
    return url


def clamp_timeout(timeout: float | None) -> float:
    """将超时限制在 ``[0, MAX_HTTP_TIMEOUT]``，缺失按上限处理。"""
    if not timeout or timeout <= 0:
        return MAX_HTTP_TIMEOUT
    return min(float(timeout), MAX_HTTP_TIMEOUT)
