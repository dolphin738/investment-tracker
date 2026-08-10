"""用户偏好 Service — 对齐 app/ UserPreferenceService。

从 routers/preference.py 内联逻辑抽出。包含：取（不存在则建默认）、PATCH 全站
唯一偏好写入口（部分更新 + 服务端白名单校验 + 蛇形字段映射 + 默认组合归属校验）。

注意：序列化仍由 router 负责（PreferenceService 返回 ORM 对象）。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import Portfolio, UserPreference
from app.services.base import PortfolioChildService


# 服务端白名单（裁决 Q-5：保持 String + 校验，零 migration）
_DATE_RANGES = ["1w", "1m", "3m", "6m", "1y", "ytd", "all"]
_GRANULARITIES = ["day", "week", "month", "year"]
_AGGREGATIONS = ["last", "avg"]
_THEMES = ["system", "light", "dark"]


def _snake(camel: str) -> str:
    out = []
    for ch in camel:
        if ch.isupper():
            out.append("_")
            out.append(ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def _validate(field: str, value: str, allowed: list[str]) -> None:
    if value not in allowed:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"{field} 取值无效：{value}（允许 {', '.join(allowed)}）",
            status_code=400,
        )


class PreferenceService(PortfolioChildService):
    async def get_or_create(self, user_id: str) -> UserPreference:
        pref = (
            await self.session.execute(
                select(UserPreference).where(UserPreference.user_id == user_id)
            )
        ).scalar_one_or_none()
        if pref is None:
            pref = UserPreference(user_id=user_id)
            self.session.add(pref)
            await self.session.commit()
            await self.session.refresh(pref)
        return pref

    async def patch(self, user_id: str, body: dict) -> UserPreference:
        pref = await self.get_or_create(user_id)

        # 白名单字段（防止任意列注入）
        allowed = {
            "defaultPortfolioId",
            "defaultGranularity",
            "defaultDateRange",
            "aggregation",
            "weekStartsOn",
            "navDecimals",
            "xirrDecimals",
            "theme",
            "staleDays",
            "showLiquidated",
            "costBasisView",
            "cashHintOnCashflow",
            "cashHintOnTrade",
            "amountThousands",
            "amountAbbrev",
        }
        unknown = set(body.keys()) - allowed
        if unknown:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message=f"未知偏好字段：{', '.join(sorted(unknown))}",
                status_code=400,
            )

        for key, value in body.items():
            if key == "defaultPortfolioId":
                # 允许显式 null 取消默认；非 null 需校验该组合属于当前用户
                if value is None:
                    pref.default_portfolio_id = None
                else:
                    owned = (
                        await self.session.execute(
                            select(Portfolio).where(
                                Portfolio.id == value,
                                Portfolio.user_id == user_id,
                            )
                        )
                    ).scalar_one_or_none()
                    if owned is None:
                        raise BusinessException(
                            code=BusinessErrorCode.VALIDATION_FAILED,
                            message="默认组合不存在或不属于当前用户",
                            status_code=400,
                        )
                    pref.default_portfolio_id = value
                continue
            if value is None:
                continue
            if key == "defaultDateRange":
                _validate("defaultDateRange", value, _DATE_RANGES)
            elif key == "defaultGranularity":
                _validate("defaultGranularity", value, _GRANULARITIES)
            elif key == "aggregation":
                _validate("aggregation", value, _AGGREGATIONS)
            elif key == "theme":
                _validate("theme", value, _THEMES)
            # 其余字段按类型直接赋值（由 ORM/DB 约束保证合法）
            setattr(pref, _snake(key), value)

        await self.session.commit()
        await self.session.refresh(pref)
        return pref
