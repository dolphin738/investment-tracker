"""待划分分红**人工裁定写路径**（批次 C §4.1/§4.3/§4.6；自 ``dividend_pending`` 拆出，A1/B4）。

裁定状态机（pending 行）：

- ``assign`` / ``batch_assign``：仅 ``PENDING`` → ``ASSIGNED``（写回主表，同格已存在则**不覆盖**）
- ``ignore`` / ``batch_ignore``：仅 ``PENDING`` → ``IGNORED``（不碰主表）
- ``reopen``：仅 ``ASSIGNED`` → ``PENDING``（连带删除 assign 写入的主表行）

三条口径要点：

1. **行锁（B5）**：三个写方法都 ``SELECT ... FOR UPDATE``。防「两个并发 assign 给**不同**
   目标期」各自插入主表行、而 pending 行只记最后一次 ``resolved_*`` → 另一行永久残留
   （同窗内还会被 ``compute_yield`` 重复计息，且无 UI 路径可回滚）。
2. **留存窗硬拒（A3=①）**：``_validate_target`` 额外拦下留存窗外年份——窗外的写入必然被
   ``DIVIDEND_RETENTION_CLEANUP`` 删除（"划分成功但过一阵静默消失"），而待划分队列主力恰是
   股改类的窗外年份。把关不能只放前端（``suggest-report-period`` 只给提示）：直连 API 可绕过。
3. **快照重算（A2=①+③）**：单笔路径 commit 后立即重算派生快照；批量路径逐笔 ``refresh=False``、
   循环结束后统一重算一次（既避免 N 倍开销，也满足 ``restate_cells``「每只每轮恰一次」）。

项级错误（``PendingItemError``）由批量端点转成 ``failed[].code``，单端点经
``_to_http_exception`` 映射为 HTTP 业务异常——``invalid_state_status`` 由调用端点决定
（assign/ignore 传 404，reopen 传 409）。

主表写入原语（``_locate_main`` / ``_insert_main`` / ``_delete_assigned_main``）在
``dividend_pending_main_write.DividendMainWriteMixin``；本 mixin 继承之，``self._xxx`` 调用
口径与拆分前一致。读侧（列表/概览/序列化）与 staging 写入仍在 ``dividend_pending.py``。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import DividendYieldSettings, SecurityDividendPending
from app.models.dividend_yield import DEFAULT_DIVIDEND_RETENTION_YEARS
from app.models.enums import DividendPendingStatus, ReportPeriodType
from app.services.dividend_cninfo_parse import retention_cutoff_year
from app.services.dividend_pending_main_write import DividendMainWriteMixin
from app.services.dividend_yield_refresh import refresh_yields_for_masters

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


class PendingDividendAssignMixin(DividendMainWriteMixin):
    """人工裁定写路径（宿主类另需提供读侧方法；本 mixin 提供 ``session`` 与写侧状态）。"""

    def __init__(self, session) -> None:
        self.session = session
        # 本请求内「已改动主表」的证券集合（A2=③）：批量端点结束后据此**统一重算一次**
        # 派生快照——既避免逐笔重算，也满足 restate_cells「每只每轮恰一次」不变式。
        self._touched_masters: set[str] = set()

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
                    # A2=③：批量逐笔**不**重算派生快照，循环结束后统一重算一次
                    refresh=False,
                )
                succeeded += 1
            except PendingItemError as err:
                await self.session.rollback()
                failed.append({"id": pid, "code": err.code, "reason": err.reason})
            except Exception as exc:  # 单项入库异常 → DB_ERROR（不中断整批）
                await self.session.rollback()
                failed.append({"id": pid, "code": ITEM_DB_ERROR, "reason": str(exc)})
        # A2=③：批量结束后统一重算一次（集合已去重）——避免逐笔重算的 N 倍开销，同时满足
        # restate_cells「每只每轮恰一次」不变式。
        await self._refresh_touched()
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
        refresh: bool = True,
    ) -> dict[str, Any]:
        # B5：行锁（SELECT ... FOR UPDATE）。防「两个并发 assign 给**不同**目标期」各自插入
        # 主表行、而 pending 行只记最后一次 resolved_* → 另一行永久残留（同窗内还会被
        # compute_yield 重复计息，且无 UI 路径可回滚）。同目标期的并发本身安全（走
        # ON CONFLICT → conflict=True），缺口仅在「不同目标期」这一支。
        pending = await self.session.get(
            SecurityDividendPending, pending_id, with_for_update=True
        )
        if pending is None:
            raise PendingItemError(ITEM_NOT_FOUND, f"待划分记录不存在：{pending_id}")
        if pending.status != DividendPendingStatus.PENDING:
            raise PendingItemError(
                ITEM_INVALID_STATE,
                f"仅 PENDING 可划分，当前状态={pending.status.value}",
            )
        # A3=①：留存窗下界硬拒（读全局配置，与采集窗 / 清理窗同口径）
        period_enum = self._validate_target(
            report_year,
            report_quarter,
            period_type,
            retention_years=await self._retention_years(),
        )

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
        # A2：**仅提交成功后**计入「本轮已改动」集合（失败路径已回滚，不该重算）
        self._touched_masters.add(pending.master_id)
        if refresh:
            # 单笔路径立即重算派生快照：/rankings、/top20 默认读派生表，不重算则最长滞后到
            # 下一次日线同步（跨周末数日），管理员会「划分成功却看不到结果」而反复操作。
            # 批量路径传 refresh=False，由批量端点在循环结束后**统一**重算一次。
            await self._refresh_touched()
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
        # 与 _assign_one 同样取行锁：避免与并发 assign 在同一 pending 行上交错读写状态
        pending = await self.session.get(
            SecurityDividendPending, pending_id, with_for_update=True
        )
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
        # A2：撤销同样改动主表（删行）→ 立即重算该证券派生快照。仅当**真删到行**时才重算：
        # 未删到行（source 守卫拦下采集侧行 / 该格本无行）时主表未变，重算无意义。
        if rolled_back:
            self._touched_masters.add(pending.master_id)
            await self._refresh_touched()
        return {
            "id": pending_id,
            "status": DividendPendingStatus.PENDING.value,
            "rolledBack": rolled_back,
        }

    def _validate_target(
        self,
        report_year: int,
        report_quarter: int,
        period_type: str,
        *,
        retention_years: int,
    ) -> ReportPeriodType:
        """校验并归一报告期；非法 → ``PendingItemError(VALIDATION_FAILED)``。

        A3=①：在原有区间（``MIN_REPORT_YEAR`` ~ 当前年+1）之外，**额外硬拒留存窗外年份**
        ——留存清理（``dividend_sync.retention_cleanup``）会删除 ``report_year <
        cur-years+1`` 的主表行，故把窗外年份写进主表等于「划分成功但过一阵静默消失」，
        而待划分队列的主力恰是股改类的窗外年份（2006~2007）。把关不能只放前端
        （``suggest-report-period`` 只给提示）：直连 API 可绕过。
        """
        today = today_app_tz()
        cur_year = today.year
        if not (MIN_REPORT_YEAR <= report_year <= cur_year + 1):
            raise PendingItemError(
                ITEM_VALIDATION_FAILED,
                f"报告年份超范围（{MIN_REPORT_YEAR}~{cur_year + 1}）：{report_year}",
            )
        cutoff = retention_cutoff_year(today, retention_years)
        if report_year < cutoff:
            raise PendingItemError(
                ITEM_VALIDATION_FAILED,
                f"报告年份在留存窗外（当前留存 {retention_years} 年，最早可划分 "
                f"{cutoff}）：{report_year}；窗外年份会被留存清理删除，建议改判为「忽略」",
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

    async def _retention_years(self) -> int:
        """读全局留存窗年数（未配置 / 显式 NULL 回落 ``DEFAULT_DIVIDEND_RETENTION_YEARS``）。

        与采集窗（``dividend_notice_scan``）、清理窗（``dividend_sync.retention_cleanup``）
        共用同一配置与同一默认值来源，确保「可划分窗 == 清理窗」——否则会出现「划分成功、
        随后被清理」的静默丢失（A3=①）。
        """
        value = (
            await self.session.execute(
                select(DividendYieldSettings.dividend_retention_years).limit(1)
            )
        ).scalar_one_or_none()
        return value if value is not None else DEFAULT_DIVIDEND_RETENTION_YEARS

    async def _refresh_touched(self) -> None:
        """重算本请求内已改动证券的派生快照（集合去重；空集直接返回，不产生无谓查询）。

        A2：单笔路径在 commit 后立即调用（管理端马上看到结果，不必等下一次日线同步）；
        批量路径在循环结束后统一调用一次——避免逐笔重算的 N 倍开销，同时满足
        ``restate_cells``「每只每轮恰一次」不变式。
        """
        if not self._touched_masters:
            return
        await refresh_yields_for_masters(self.session, sorted(self._touched_masters))
        await self.session.commit()
        self._touched_masters.clear()
