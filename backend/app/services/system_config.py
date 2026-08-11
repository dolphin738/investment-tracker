"""系统配置服务 — 键值型配置的读 / 写 / 读取或播种。

- get(key) / set(key, value, actor_id)：单条读取 / upsert（供 admin 路由使用）。
- get_value(key)：仅取结构化值（dict），无则返回 None。
- get_or_seed(key, env_var)：DB 无则读取同名环境变量写入后再返回；
  环境变量也无则回退 {"url": ""}（保证调用方永远拿到合法结构）。
- get_quote_api_base_url(db)：读取 securities_quote_api_base_url 的 url，
  无 DB 行时回退 settings.SECURITIES_QUOTE_API_BASE_URL，都没有返回 ""。

所有写入走 upsert，避免并发重复插入 unique 冲突；actor_id 用于审计。
"""
from __future__ import annotations

import os
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import SystemConfig


class SystemConfigService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, key: str) -> Optional[SystemConfig]:
        return (
            await self.session.execute(
                select(SystemConfig).where(SystemConfig.key == key)
            )
        ).scalar_one_or_none()

    async def set(
        self, key: str, value: dict[str, Any], actor_id: Optional[str] = None
    ) -> SystemConfig:
        """upsert：存在则更新 config_value / updated_by，不存在则插入。"""
        existing = await self.get(key)
        if existing is None:
            existing = SystemConfig(key=key, config_value=value, updated_by=actor_id)
            self.session.add(existing)
        else:
            existing.config_value = value
            existing.updated_by = actor_id
        await self.session.flush()
        return existing

    async def get_value(self, key: str) -> Optional[dict[str, Any]]:
        cfg = await self.get(key)
        return cfg.config_value if cfg is not None else None

    async def get_or_seed(self, key: str, env_var: str) -> dict[str, Any]:
        """DB 无此 key 时，读同名环境变量写入再返回；都没有回退 {"url": ""}。"""
        cfg = await self.get(key)
        if cfg is not None:
            return cfg.config_value
        env_val = os.environ.get(env_var) or getattr(
            get_settings(), env_var, None
        )
        value: dict[str, Any] = {"url": env_val or ""}
        await self.set(key, value, None)
        await self.session.flush()
        return value


async def get_quote_api_base_url(db: AsyncSession) -> str:
    """证券行情 API 基础地址。

    读取顺序：DB 系统配置 securities_quote_api_base_url 的 config_value["url"]
    → settings.SECURITIES_QUOTE_API_BASE_URL（env）→ ""。
    """
    settings = get_settings()
    svc = SystemConfigService(db)
    cfg = await svc.get("securities_quote_api_base_url")
    if cfg is not None and isinstance(cfg.config_value, dict):
        url = cfg.config_value.get("url")
        if url:
            return url
    return getattr(settings, "SECURITIES_QUOTE_API_BASE_URL", "") or ""
