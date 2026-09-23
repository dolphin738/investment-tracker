"""待划分分红「写回主表」原语（批次 C §4.3/§4.6；自 ``dividend_pending`` 拆出，A1/B4）。

只做一件事：把人工裁定的结果落到主表 ``security_dividends``。三个方法都按**唯一键**
``(master_id, report_year, report_quarter, period_type)`` 定位/写入，**不碰** pending 行状态。

- ``_locate_main``：按唯一键定位存量行——调用方据此区分「主表同格本来就有」（不覆盖）
  与「本次插入失败」。
- ``_insert_main``：``INSERT ... ON CONFLICT DO NOTHING RETURNING id``——并发 scan 不触发
  ``IntegrityError``；命中唯一键返回 ``False``（不覆盖既有，D-3）。
- ``_delete_assigned_main``：撤销时删除**由人工划分写入**的行（``source`` 守卫，A4=②）。

与 ``dividend_pending_assign`` 的分工：本 mixin 只提供主表原语，裁定编排（状态机 / 校验 /
快照重算）在 ``PendingDividendAssignMixin``（继承本类），最终由 ``PendingDividendService``
（``dividend_pending.py``）聚合——``self._locate_main`` 等调用点与拆分前**完全一致**。
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models import SecurityDividend, SecurityDividendPending
from app.models.enums import DividendStatus, ReportPeriodType

# 人工划分写回主表时的 source 标记：pending 表不存 source，用常量标注「非采集源写入」，
# 便于审计与排查（不影响采集侧 ``_locate_cell`` 按唯一键定位——它不看 source）。
ASSIGN_SOURCE = "人工划分"


class DividendMainWriteMixin:
    """主表 ``security_dividends`` 写入原语（宿主类须提供 ``self.session``）。"""

    async def _locate_main(
        self,
        master_id: str,
        report_year: int,
        report_quarter: int,
        period_enum: ReportPeriodType,
    ) -> Optional[SecurityDividend]:
        """按主表唯一键 (master_id, report_year, report_quarter, period_type) 定位存量行。"""
        return (
            await self.session.execute(
                select(SecurityDividend)
                .where(
                    SecurityDividend.master_id == master_id,
                    SecurityDividend.report_year == report_year,
                    SecurityDividend.report_quarter == report_quarter,
                    SecurityDividend.period_type == period_enum,
                )
                .limit(1)
            )
        ).scalar_one_or_none()

    async def _insert_main(
        self,
        pending: SecurityDividendPending,
        report_year: int,
        report_quarter: int,
        period_enum: ReportPeriodType,
    ) -> bool:
        """主表原子写入：``INSERT ... ON CONFLICT DO NOTHING RETURNING id``。

        返回 ``True`` 表示确由本次插入（无冲突）；``False`` 表示命中唯一键（并发场景）。

        status 推导与采集侧同口径（§9.2）：除权日非空 → ``PAID``，否则 ``PROPOSED``。
        """
        stmt = (
            pg_insert(SecurityDividend)
            .values(
                id=str(uuid.uuid4()),
                master_id=pending.master_id,
                report_year=report_year,
                report_quarter=report_quarter,
                period_type=period_enum,
                cash_per_share=pending.cash_per_share,
                status=(
                    DividendStatus.PAID
                    if pending.ex_dividend_date is not None
                    else DividendStatus.PROPOSED
                ),
                ex_dividend_date=pending.ex_dividend_date,
                announcement_date=pending.announcement_date,
                record_date=pending.record_date,
                source=ASSIGN_SOURCE,
                bonus_share_ratio=pending.bonus_share_ratio,
                convert_ratio=pending.convert_ratio,
                dividend_label=pending.dividend_label,
            )
            .on_conflict_do_nothing(
                index_elements=[
                    "master_id",
                    "report_year",
                    "report_quarter",
                    "period_type",
                ]
            )
            .returning(SecurityDividend.id)
        )
        res = await self.session.execute(stmt)
        return res.scalar_one_or_none() is not None

    async def _delete_assigned_main(self, pending: SecurityDividendPending) -> bool:
        """删除 assign 写入的主表行（``resolved_*`` 组键 **+** ``source = 人工划分``）。

        ``source`` 守卫（A4=②，owner 裁定「主表数据可以清除掉」下仍按来源精确化）解决
        §4.6 未覆盖的一支：assign 命中「主表同格已存在」时**并未写入任何行**
        （``conflict=True``），若撤销只按四元组键删，删掉的其实是采集侧写入的合法行，
        接口却报 ``rolledBack=true``——语义上等于「撤销了本不该动的那笔」。

        失效方向是**安全侧**：若采集侧后来更新过同格、把 ``source`` 改写为数据源名，
        本行不会被删除（管理员再点一次即可），绝不会反过来误删采集侧数据。

        已知副作用（§4.6 已留痕）：assign 写入后 daily scan 又更新同格且未改 ``source``
        时，仍会一并删除——属「恢复为未划分」的预期。缺 ``resolved_*``（异常态）时不动主表。
        """
        if (
            pending.resolved_report_year is None
            or pending.resolved_report_quarter is None
            or not pending.resolved_period_type
        ):
            return False
        try:
            period_enum = ReportPeriodType(pending.resolved_period_type)
        except ValueError:
            return False
        res = await self.session.execute(
            sa_delete(SecurityDividend).where(
                SecurityDividend.master_id == pending.master_id,
                SecurityDividend.report_year == pending.resolved_report_year,
                SecurityDividend.report_quarter == pending.resolved_report_quarter,
                SecurityDividend.period_type == period_enum,
                SecurityDividend.source == ASSIGN_SOURCE,
            )
        )
        return (res.rowcount or 0) > 0
