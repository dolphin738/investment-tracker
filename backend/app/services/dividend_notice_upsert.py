"""公告扫描的单只「落库辅助查询」（定位 / 跨源去重护栏 / 取消置位）。

从 ``dividend_notice_scan.py`` 拆出（A11-②）：该文件在加入队列龄期度量后达 431 行，再破
``docs/架构治理规范.md`` §4「存量超限文件禁止继续增长」的 400 行人工上限。本模块只承接
**不含计数与日志**的四个查询/置位方法——``_locate_cell`` / ``_first`` / ``_westward_dup`` /
``_reject_proposed``——以 mixin（``NoticeUpsertMixin``）提供，宿主
``DividendNoticeScanService`` 继承之：故 ``self._x`` 调用口径与拆分前**逐字未变**，
``_upsert_one``（留在主文件）继续以 ``self`` 调用它们。

**归属约定（三个 notice 模块不再互相越界）**：
- ``dividend_notice_meta.py``：选源 / 标题二筛 / 失败后重解析。
- ``dividend_notice_upsert.py``（本模块）：按唯一键定位 / 跨源去重 / 取消置位。
- ``dividend_notice_scan.py``：落库主流程与 upsert 编排 + 计数与日志
  （``_bump`` 是主文件的模块级函数；若随方法迁出会形成环导入，故计数与日志一律留下）。
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import select

from app.models import SecurityDividend
from app.models.enums import DividendStatus
from app.services.dividend_cninfo_parse import CninfoDividendRow


class NoticeUpsertMixin:
    """单只落库辅助查询（宿主须提供 ``self.session``）。"""

    async def _locate_cell(self, mid: str, row: CninfoDividendRow) -> Optional[SecurityDividend]:
        """按唯一键 (master_id, report_year, report_quarter, period_type) 定位存量行。"""
        return (
            await self.session.execute(
                select(SecurityDividend)
                .where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.report_year == row.report_year,
                    SecurityDividend.report_quarter == row.report_quarter,
                    SecurityDividend.period_type == row.period_type,
                )
                .limit(1)
            )
        ).scalar_one_or_none()

    async def _first(self, *where: Any) -> Optional[Any]:
        """去重护栏类查询收口：按条件取首行 id，无命中返回 None。"""
        return (
            await self.session.execute(select(SecurityDividend.id).where(*where).limit(1))
        ).scalar_one_or_none()

    async def _westward_dup(self, mid, ex_date, ry, rq, cash, source) -> bool:
        """西向去重：同 master 已有「跨源 + ex_date 相等」或「跨源 + (ry,rq,cash) 全等」
        记录 → 跳过重写。

        **L2（2026-09-22）跨源限定**：两分支均追加 ``source != <入参 source>`` 条件，
        **同源（含同一接口拆出的两行）一律豁免**。理由：巨潮把一次分配拆成「年度 + 特别」
        两行、同 ``ex_date`` 异 ``cash``，二者是**兄弟分量而非重复**；旧口径仅按 ``ex_date``
        判重会把第二个分量误杀（丢哪一半取决于源站行序），故同源必须豁免。
        **反向陷阱**：两分支**不得**加 ``period_type`` 相等条件——旧新浪链路把每行都写
        成 ``SPECIAL``，加 ``period_type`` 相等会让 ``SPECIAL≠ANNUAL`` 漏挡跨源重复。

        **取舍（§5.6 二次护栏）**：本方法只在**新增**路径生效——目标格未命中时才调用。
        旧代码每次写行前都先过本方法，其 ``(ry,rq,cash) 全等 → 跳过`` 分支会把「同格
        同额」行判为重复，导致除权日/登记日/送转比例等后续事实永远无法刷新（全历史
        重跑时预案期写入的 PROPOSED 行无法升级为 PAID）。故改为：先按唯一键定位
        （命中即更新），未命中再走本护栏。
        """
        if ex_date is not None and await self._first(
            SecurityDividend.master_id == mid,
            SecurityDividend.ex_dividend_date == ex_date,
            SecurityDividend.source != source,
        ) is not None:
            return True
        return await self._first(
            SecurityDividend.master_id == mid,
            SecurityDividend.report_year == ry,
            SecurityDividend.report_quarter == rq,
            SecurityDividend.cash_per_share == cash,
            SecurityDividend.source != source,
        ) is not None

    async def _reject_proposed(self, mid: str) -> int:
        """取消/终止：该 master 的存量 PROPOSED 行置 REJECTED；返回置位数。

        放宽为**不限 period_type**：旧链路只写 SPECIAL 故原查询带 ``period_type == SPECIAL``
        过滤；批次 A 后新链路按「分红类型」写 ANNUAL/INTERIM/QUARTERLY/SPECIAL/OTHER
        （含 SPECIAL 与 OTHER），沿用旧过滤会使取消/复查路径漏掉非 SPECIAL 的存量行
        （取消公告命中后一行都置不上）。
        """
        rows = (
            await self.session.execute(
                select(SecurityDividend).where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.status == DividendStatus.PROPOSED,
                )
            )
        ).scalars().all()
        for r in rows:
            r.status = DividendStatus.REJECTED
        return len(rows)
