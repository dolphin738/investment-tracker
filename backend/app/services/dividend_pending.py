"""待人工划分分红 staging 服务（批次 B 写入 + 批次 C 人工裁定）。

承载两块职责：

1. **staging 写入**（``stage_pending``，批次 B，§3.7）：把「现金 >0 但报告时间不可解析」的
   巨潮行幂等落 ``security_dividend_pending``。返回 ``True`` 仅表示「新落一行待划分」；
   调用方（scan / seed）**不得**据此把 ``master_id`` 加入派生快照重算集——staging 不改变
   主表 ``security_dividends``，故不影响股息率。度量经 ``stats["staged"]`` 暴露。
2. **人工裁定**（``PendingDividendService``，批次 C，§4）：列表 / 概览 / 划分 / 批量划分 /
   忽略 / 批量忽略 / 撤销。划分写回主表 ``security_dividends``（主表同格已存在则**保留旧值
   不覆盖**，D-3 冲突可见）；撤销连带删除 assign 写入的主表同键行。

**主表写入原子性**：assign 用 ``INSERT ... ON CONFLICT (唯一键) DO NOTHING``——并发 scan
不触发 ``IntegrityError``；命中即 ``conflict=True``（不覆盖既有）。以 ``DO NOTHING`` 而非
``DO UPDATE`` 是为满足 D-3「不覆盖既有」（见设计 §1 / §4.3 的调和记录）。

**assign 不删 pending 行**：删行会因 fingerprint 缺失去重而在下次 scan 复活，故只置
``ASSIGNED`` + ``resolved_*``。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.date_utils import today_app_tz
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import Security, SecurityDividend, SecurityDividendPending
from app.models.enums import DividendPendingStatus, DividendStatus, ReportPeriodType
from app.services.base import paged
from app.services.dividend_cninfo_parse import (
    KNOWN_LABELS,
    PendingDividendRow,
    pending_fingerprint,
)

# 人工划分写回主表时的 source 标记：pending 表不存 source，用常量标注「非采集源写入」，
# 便于审计与排查（不影响采集侧 ``_locate_cell`` 按唯一键定位——它不看 source）。
ASSIGN_SOURCE = "人工划分"

# 报告年份合法区间下界（上界 = 当前年 + 1，见 ``_validate_target``）
MIN_REPORT_YEAR = 1990

# —— 项级错误码（批量端点 failed[].code 的纯字符串取值，§9.3）——
ITEM_NOT_FOUND = "NOT_FOUND"
ITEM_INVALID_STATE = "INVALID_STATE"
ITEM_VALIDATION_FAILED = "VALIDATION_FAILED"
ITEM_DB_ERROR = "DB_ERROR"


class PendingItemError(Exception):
    """项级错误：携带纯字符串 ``code``（批量端点据此填 ``failed[]``）。

    单端点（assign/ignore/reopen）捕获后经 ``_to_http_exception`` 映射为 HTTP 业务异常。
    """

    def __init__(self, code: str, reason: str) -> None:
        self.code = code
        self.reason = reason
        super().__init__(reason)


def _to_http_exception(
    err: PendingItemError, *, invalid_state_status: int
) -> BusinessException:
    """项级错误 → HTTP 业务异常。

    ``invalid_state_status`` 由调用端点决定：assign / ignore 传 404（§4.1 表：这两端点只列
    404，不列 409），reopen 传 409（§4.1 表 reopen 含 409；§4.6「仅 ASSIGNED 可撤销」）。
    """
    if err.code == ITEM_NOT_FOUND:
        return BusinessException(
            code=BusinessErrorCode.NOT_FOUND, message=err.reason, status_code=404
        )
    if err.code == ITEM_INVALID_STATE:
        return BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=err.reason,
            status_code=invalid_state_status,
        )
    # VALIDATION_FAILED / DB_ERROR
    return BusinessException(
        code=BusinessErrorCode.VALIDATION_FAILED, message=err.reason, status_code=400
    )


async def stage_pending(session, master_id: str, row: PendingDividendRow) -> bool:
    """幂等落一行待划分 staging；返回是否为**新插入**（重复 fingerprint → False）。

    幂等键 ``row_fingerprint``（``pending_fingerprint`` 生成）唯一；写入用
    ``INSERT ... ON CONFLICT (row_fingerprint) DO NOTHING``——重复 scan 不产生重复行。

    Args:
        session: 活动 ``AsyncSession``（调用方负责 commit）。
        master_id: 证券主数据目录行 id（``securities.id``）。
        row: ``parse_pending_row`` 构造的待划分行。

    Returns:
        ``True`` 仅当本次**新插入**一行；命中既有 fingerprint（``DO NOTHING``）为 ``False``。

    Note:
        调用方**不得**因返回 ``True`` 把 ``master_id`` 计入快照重算集（staging 不计入
        ``changed``，§3.7）。
    """
    fingerprint = pending_fingerprint(master_id, row)
    stmt = (
        pg_insert(SecurityDividendPending)
        .values(
            id=str(uuid.uuid4()),
            master_id=master_id,
            row_fingerprint=fingerprint,
            status=DividendPendingStatus.PENDING,
            **row.fields(),
        )
        .on_conflict_do_nothing(index_elements=["row_fingerprint"])
    )
    result = await session.execute(stmt)
    return bool(result.rowcount)


class PendingDividendService:
    """待划分分红的查询与人工裁定服务（批次 C，§4）。

    排序**固定** ``created_at DESC, id DESC``（不提供 ``sort`` 参数，D-7）；列表筛选
    ``status`` / ``label``（精确）/ ``q``（证券代码或名称 ilike）；分页复用
    ``services.base.paged``。
    """

    def __init__(self, session) -> None:
        self.session = session

    # ------------------------------------------------------------------ #
    # 查询（读端点）
    # ------------------------------------------------------------------ #
    async def list_pending(
        self,
        *,
        status: Optional[str] = None,
        label: Optional[str] = None,
        q: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        """分页列表：固定排序 ``created_at DESC, id DESC``；筛选 status/label/q（§4.5）。"""
        conditions = []
        if status:
            conditions.append(
                SecurityDividendPending.status == self._parse_status(status)
            )
        if label:
            conditions.append(SecurityDividendPending.dividend_label == label)
        q_kw = (q or "").strip() or None

        stmt = select(SecurityDividendPending)
        if q_kw is not None:
            like = f"%{q_kw}%"
            stmt = stmt.join(Security, Security.id == SecurityDividendPending.master_id)
            conditions.append(or_(Security.code.ilike(like), Security.name.ilike(like)))
        stmt = stmt.where(*conditions).order_by(
            SecurityDividendPending.created_at.desc(),
            SecurityDividendPending.id.desc(),
        )

        rows, total = await paged(self.session, stmt, page, page_size)
        sec_map = await self._sec_map([r.master_id for r in rows])
        items = [self._serialize(r, sec_map.get(r.master_id)) for r in rows]
        return {"items": items, "total": total, "page": page, "pageSize": page_size}

    async def summary(self) -> dict[str, Any]:
        """概览：各状态计数 + ``labels[]``（``KNOWN_LABELS`` ∪ 表内 DISTINCT 非空标签，D-8）。"""
        grouped = (
            await self.session.execute(
                select(SecurityDividendPending.status, func.count()).group_by(
                    SecurityDividendPending.status
                )
            )
        ).all()
        counts = {s: 0 for s in DividendPendingStatus}
        for status_enum, n in grouped:
            counts[status_enum] = int(n)

        label_rows = (
            await self.session.execute(
                select(SecurityDividendPending.dividend_label)
                .where(SecurityDividendPending.dividend_label.is_not(None))
                .distinct()
            )
        ).scalars().all()
        labels = sorted(set(KNOWN_LABELS) | {lb for lb in label_rows if lb})

        pending = counts[DividendPendingStatus.PENDING]
        assigned = counts[DividendPendingStatus.ASSIGNED]
        ignored = counts[DividendPendingStatus.IGNORED]
        return {
            "pending": pending,
            "assigned": assigned,
            "ignored": ignored,
            "total": pending + assigned + ignored,
            "labels": labels,
        }

    # ------------------------------------------------------------------ #
    # 人工裁定（写端点）
    # ------------------------------------------------------------------ #
    async def assign(
        self,
        pending_id: str,
        *,
        report_year: int,
        report_quarter: int,
        period_type: str,
        user_id: str,
    ) -> dict[str, Any]:
        """划分单笔：写回主表 + 置 ``ASSIGNED``（§4.3；冲突可见、不覆盖，D-3）。"""
        try:
            return await self._assign_one(
                pending_id,
                report_year=report_year,
                report_quarter=report_quarter,
                period_type=period_type,
                user_id=user_id,
            )
        except PendingItemError as err:
            await self.session.rollback()
            raise _to_http_exception(err, invalid_state_status=404) from None

    async def batch_assign(
        self, items: list[dict[str, Any]], *, user_id: str
    ) -> dict[str, Any]:
        """批量划分：逐项独立提交，部分失败返回 ``{succeeded, failed[]}``（§4.1）。

        ``items`` 为 ``{id, report_year, report_quarter, period_type}`` 列表（snake_case，
        由路由从请求体转换）。
        """
        succeeded = 0
        failed: list[dict[str, str]] = []
        for it in items:
            pid = it["id"]
            try:
                await self._assign_one(
                    pid,
                    report_year=it["report_year"],
                    report_quarter=it["report_quarter"],
                    period_type=it["period_type"],
                    user_id=user_id,
                )
                succeeded += 1
            except PendingItemError as err:
                await self.session.rollback()
                failed.append({"id": pid, "code": err.code, "reason": err.reason})
            except Exception as exc:  # 单项入库异常 → DB_ERROR（不中断整批）
                await self.session.rollback()
                failed.append({"id": pid, "code": ITEM_DB_ERROR, "reason": str(exc)})
        return {"succeeded": succeeded, "failed": failed}

    async def ignore(self, pending_id: str) -> dict[str, Any]:
        """忽略单笔：仅 ``PENDING`` 可忽略 → ``IGNORED``（不写回主表）。"""
        try:
            return await self._ignore_one(pending_id)
        except PendingItemError as err:
            await self.session.rollback()
            raise _to_http_exception(err, invalid_state_status=404) from None

    async def batch_ignore(self, ids: list[str]) -> dict[str, Any]:
        """批量忽略：逐项独立提交，部分失败返回 ``{succeeded, failed[]}``。"""
        succeeded = 0
        failed: list[dict[str, str]] = []
        for pid in ids:
            try:
                await self._ignore_one(pid)
                succeeded += 1
            except PendingItemError as err:
                await self.session.rollback()
                failed.append({"id": pid, "code": err.code, "reason": err.reason})
            except Exception as exc:
                await self.session.rollback()
                failed.append({"id": pid, "code": ITEM_DB_ERROR, "reason": str(exc)})
        return {"succeeded": succeeded, "failed": failed}

    async def reopen(self, pending_id: str) -> dict[str, Any]:
        """撤销单笔：仅 ``ASSIGNED`` 可撤销 → 连带删除 assign 写入的主表同键行（§4.6）。"""
        try:
            return await self._reopen_one(pending_id)
        except PendingItemError as err:
            await self.session.rollback()
            raise _to_http_exception(err, invalid_state_status=409) from None

    # ------------------------------------------------------------------ #
    # 内部实现
    # ------------------------------------------------------------------ #
    async def _assign_one(
        self,
        pending_id: str,
        *,
        report_year: int,
        report_quarter: int,
        period_type: str,
        user_id: str,
    ) -> dict[str, Any]:
        pending = await self.session.get(SecurityDividendPending, pending_id)
        if pending is None:
            raise PendingItemError(ITEM_NOT_FOUND, f"待划分记录不存在：{pending_id}")
        if pending.status != DividendPendingStatus.PENDING:
            raise PendingItemError(
                ITEM_INVALID_STATE,
                f"仅 PENDING 可划分，当前状态={pending.status.value}",
            )
        period_enum = self._validate_target(report_year, report_quarter, period_type)

        existing = await self._locate_main(
            pending.master_id, report_year, report_quarter, period_enum
        )
        if existing is not None:
            conflict = True
            warning = (
                f"主表同格已存在、未覆盖（原标签={existing.dividend_label} / "
                f"本次={pending.dividend_label}）"
            )
        else:
            inserted = await self._insert_main(
                pending, report_year, report_quarter, period_enum
            )
            conflict = not inserted
            warning = (
                "主表同格已存在、未覆盖（并发写入）" if conflict else None
            )

        pending.status = DividendPendingStatus.ASSIGNED
        pending.resolved_period_type = period_enum.value  # 存字符串，非枚举（§9.1）
        pending.resolved_report_year = report_year
        pending.resolved_report_quarter = report_quarter
        pending.resolved_at = datetime.now(timezone.utc)
        pending.resolved_by = user_id
        await self.session.commit()
        return {
            "id": pending_id,
            "status": DividendPendingStatus.ASSIGNED.value,
            "conflict": conflict,
            "warning": warning,
            "reportYear": report_year,
            "reportQuarter": report_quarter,
            "periodType": period_enum.value,
        }

    async def _ignore_one(self, pending_id: str) -> dict[str, Any]:
        pending = await self.session.get(SecurityDividendPending, pending_id)
        if pending is None:
            raise PendingItemError(ITEM_NOT_FOUND, f"待划分记录不存在：{pending_id}")
        if pending.status != DividendPendingStatus.PENDING:
            raise PendingItemError(
                ITEM_INVALID_STATE,
                f"仅 PENDING 可忽略，当前状态={pending.status.value}",
            )
        pending.status = DividendPendingStatus.IGNORED
        await self.session.commit()
        return {"id": pending_id, "status": DividendPendingStatus.IGNORED.value}

    async def _reopen_one(self, pending_id: str) -> dict[str, Any]:
        pending = await self.session.get(SecurityDividendPending, pending_id)
        if pending is None:
            raise PendingItemError(ITEM_NOT_FOUND, f"待划分记录不存在：{pending_id}")
        if pending.status != DividendPendingStatus.ASSIGNED:
            raise PendingItemError(
                ITEM_INVALID_STATE,
                f"仅 ASSIGNED 可撤销，当前状态={pending.status.value}",
            )
        rolled_back = await self._delete_assigned_main(pending)
        pending.status = DividendPendingStatus.PENDING
        pending.resolved_period_type = None
        pending.resolved_report_year = None
        pending.resolved_report_quarter = None
        pending.resolved_at = None
        pending.resolved_by = None
        await self.session.commit()
        return {
            "id": pending_id,
            "status": DividendPendingStatus.PENDING.value,
            "rolledBack": rolled_back,
        }

    def _validate_target(
        self, report_year: int, report_quarter: int, period_type: str
    ) -> ReportPeriodType:
        """校验并归一报告期；非法 → ``PendingItemError(VALIDATION_FAILED)``。"""
        cur_year = today_app_tz().year
        if not (MIN_REPORT_YEAR <= report_year <= cur_year + 1):
            raise PendingItemError(
                ITEM_VALIDATION_FAILED,
                f"报告年份超范围（{MIN_REPORT_YEAR}~{cur_year + 1}）：{report_year}",
            )
        if not (1 <= report_quarter <= 4):
            raise PendingItemError(
                ITEM_VALIDATION_FAILED, f"报告季度须在 1~4：{report_quarter}"
            )
        try:
            period_enum = ReportPeriodType(period_type)
        except ValueError:
            raise PendingItemError(
                ITEM_VALIDATION_FAILED, f"不支持的报告期类型：{period_type}"
            ) from None
        return period_enum

    def _parse_status(self, raw: str) -> DividendPendingStatus:
        """列表 status 筛选取值校验；非法 → 400（VALIDATION_FAILED）。"""
        try:
            return DividendPendingStatus(raw)
        except ValueError:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message=f"不支持的待划分状态：{raw}",
                status_code=400,
            ) from None

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
        """按 ``resolved_*`` 组唯一键删除 assign 写入的主表行；返回是否删到行。

        已知副作用（§4.6）：若 assign 后 daily scan 又在该键写入一行，会一并删除——属
        「恢复为未划分」的预期。缺 ``resolved_*``（异常态）时不动主表。
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
            )
        )
        return (res.rowcount or 0) > 0

    async def _sec_map(self, mids: list[str]) -> dict[str, Security]:
        """按 master_id 批量取证券主数据，供序列化填充 code/name/exchange。"""
        if not mids:
            return {}
        rows = (
            await self.session.execute(select(Security).where(Security.id.in_(mids)))
        ).scalars().all()
        return {s.id: s for s in rows}

    def _serialize(
        self, row: SecurityDividendPending, sec: Optional[Security]
    ) -> dict[str, Any]:
        """待划分行 → wire（camelCase）。

        金额字段**直接透传 ``Decimal``**、日期透传 ``date/datetime``，由信封编码器
        （``decimal_jsonable_encoder``）统一 str 化 / ISO 化——不在序列化层手动
        ``str()``（口径一致、避免 ``None`` 误转成字符串 ``"None"``）。
        """
        return {
            "id": row.id,
            "masterId": row.master_id,
            "code": sec.code if sec else None,
            "name": sec.name if sec else None,
            "exchange": sec.exchange if sec else None,
            "dividendLabel": row.dividend_label,
            "cashPerShare": row.cash_per_share,
            "bonusShareRatio": row.bonus_share_ratio,
            "convertRatio": row.convert_ratio,
            "recordDate": row.record_date,
            "exDividendDate": row.ex_dividend_date,
            "payDate": row.pay_date,
            "announcementDate": row.announcement_date,
            "reportPeriodRaw": row.report_period_raw,
            "status": row.status.value,
            "resolvedPeriodType": row.resolved_period_type,
            "resolvedReportYear": row.resolved_report_year,
            "resolvedReportQuarter": row.resolved_report_quarter,
            "createdAt": row.created_at,
            "resolvedAt": row.resolved_at,
        }
