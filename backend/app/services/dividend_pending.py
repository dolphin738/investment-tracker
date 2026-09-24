"""待人工划分分红 staging 服务（批次 B staging 写入 + 批次 C 读侧）。

承载两块职责（**写路径**已拆出，见下）：

1. **staging 写入**（``stage_pending``，批次 B，§3.7）：把「现金 >0 但报告时间不可解析」的
   巨潮行幂等落 ``security_dividend_pending``。返回 ``True`` 仅表示「新落一行待划分」；
   调用方（scan / seed）**不得**据此把 ``master_id`` 加入派生快照重算集——staging 不改变
   主表 ``security_dividends``，故不影响股息率。度量经 ``stats["staged"]`` 暴露。
2. **读侧**（``PendingDividendService``，批次 C）：列表 / 概览 / 序列化。排序固定
   ``created_at DESC, id DESC``（D-7）；筛选 ``status`` / ``label``（精确）/ ``q``（证券代码
   或名称 ilike）；分页复用 ``services.base.paged``。
3. **队列度量**（``pending_queue_metrics``，A9）：深度 + 最老龄期 + 龄期分桶，供采集链路在
   摘要与告警里给出「队列在腐化」的信号——队列不受留存清理约束（清理只动主表），
   没有这个信号积压只会静默增长（审查项 S19）。

**模块拆分（A1/B4）**：人工裁定**写路径**（assign / batch_assign / ignore / batch_ignore /
reopen + 报告期校验 + 派生快照重算 + 项级错误映射）已抽到 ``dividend_pending_assign.py``
（``PendingDividendAssignMixin``），主表写入原语在 ``dividend_pending_main_write.py``
（``DividendMainWriteMixin``）。本类继承前者，故 ``stage_pending`` /
``PendingDividendService`` 的**导入路径与调用口径完全不变**（``pending_router``、
``dividend_notice_scan`` 无需改动）。

**主表写入原子性**：assign 用 ``INSERT ... ON CONFLICT (唯一键) DO NOTHING``——并发 scan
不触发 ``IntegrityError``；命中即 ``conflict=True``（不覆盖既有）。以 ``DO NOTHING`` 而非
``DO UPDATE`` 是为满足 D-3「不覆盖既有」（见设计 §1 / §4.3 的调和记录）。

**assign 不删 pending 行**：删行会因 fingerprint 缺失去重而在下次 scan 复活，故只置
``ASSIGNED`` + ``resolved_*``。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import Security, SecurityDividendPending
from app.models.enums import DividendPendingStatus
from app.services.base import paged
from app.services.dividend_cninfo_parse import (
    KNOWN_LABELS,
    PendingDividendRow,
    pending_fingerprint,
)
from app.services.dividend_pending_assign import PendingDividendAssignMixin
from app.services.dividend_period import period_label, plan_label


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


# 待划分队列「积压龄期」告警阈值（天）：最老 PENDING 行超过该龄期即判队列在腐化（A9）。
# 取值理由：队列随每日扫描/播种增长，正常运维节奏应在数周内处理完（划分或忽略）；
# 半年无人触碰意味着**没有人再看这个页面**，此时任何计数都不足以报警，必须有龄期信号。
PENDING_QUEUE_STALE_DAYS = 180

# 龄期分桶边界（天）：让告警一眼看出积压是「新近堆的」还是「陈年遗留」。
_PENDING_AGE_BUCKETS: tuple[int, int, int] = (30, 180, 365)


async def pending_queue_metrics(session) -> dict[str, Any]:
    """待划分队列度量：深度 + 最老龄期 + 龄期分桶（A9=②，收口审查项 S19）。

    只统计 ``PENDING``（真正待人工裁定的行）；``ASSIGNED``/``IGNORED`` 已裁定，不计入。

    为什么需要它：``no_period`` 行因「报告时间不可解析、年份未知」**必然全部入队**
    （含 1998~2007 等窗外老行），且队列**不受留存清理约束**——``retention_cleanup`` 只删
    主表 ``security_dividends``，pending 行不会随年份流逝自行消失。没有随规模/龄期变化的
    信号，积压会静默增长到「管理员不再相信页面计数」为止。

    Returns:
        ``{pending, oldestCreatedAt, oldestAgeDays, buckets, stale}``；
        ``buckets`` 键固定为 ``lte30`` / ``d31_180`` / ``d181_365`` / ``gt365``。
        队列为空时 ``oldestCreatedAt``/``oldestAgeDays`` 为 ``None``、分桶全 0、``stale=False``。
    """
    now = datetime.now(timezone.utc)
    c30 = now - timedelta(days=_PENDING_AGE_BUCKETS[0])
    c180 = now - timedelta(days=_PENDING_AGE_BUCKETS[1])
    c365 = now - timedelta(days=_PENDING_AGE_BUCKETS[2])
    created = SecurityDividendPending.created_at
    row = (
        await session.execute(
            select(
                func.count(),
                func.min(created),
                func.count().filter(created >= c30),
                func.count().filter(created >= c180),
                func.count().filter(created >= c365),
            ).where(SecurityDividendPending.status == DividendPendingStatus.PENDING)
        )
    ).one()
    pending, oldest, n30, n180, n365 = (int(row[0]), row[1], *map(int, row[2:]))
    oldest_age = (now - oldest).days if oldest is not None else None
    return {
        "pending": pending,
        "oldestCreatedAt": oldest.isoformat() if oldest is not None else None,
        "oldestAgeDays": oldest_age,
        "buckets": {
            "lte30": n30,
            "d31_180": n180 - n30,
            "d181_365": n365 - n180,
            "gt365": pending - n365,
        },
        "stale": oldest_age is not None and oldest_age > PENDING_QUEUE_STALE_DAYS,
    }


def pending_queue_age_text(metrics: dict[str, Any]) -> str:
    """队列「最老龄期」文案：空队列为 ``—``（摘要片段复用，避免各调用方各写一份）。"""
    age = metrics["oldestAgeDays"]
    return "—" if age is None else f"{age}天"


def pending_queue_warning(metrics: dict[str, Any]) -> Optional[str]:
    """队列积压告警文案；未超阈值返回 ``None``。

    阈值判据、龄期分桶与措辞全部收口在本模块（队列语义的唯一归属地），调用方（采集链路）
    只负责「拿到非 None 就 WARNING」。文案给出分桶分布与**处置动作**——只报「积压」而
    不说怎么办的告警，收件人只会习惯性忽略。
    """
    if not metrics["stale"]:
        return None
    b = metrics["buckets"]
    return (
        f"待划分队列积压：PENDING {metrics['pending']} 条、最老 "
        f"{pending_queue_age_text(metrics)}（阈值 {PENDING_QUEUE_STALE_DAYS} 天）；龄期分布 "
        f"≤30天{b['lte30']}/31~180天{b['d31_180']}/181~365天{b['d181_365']}/"
        f">365天{b['gt365']}。队列不随留存清理缩小，请在「待人工划分」页批量划分或忽略。"
    )


# LIKE 模式转义（S24）：`q` 来自用户输入，`%` / `_` 必须按**字面**匹配——否则 `q=%`
# 会命中全表（管理员一次「全选式」检索即把整库拉出），`q=_` 也会退化成任意单字符。
_LIKE_ESCAPE = "\\"


def _like_pattern(raw: str) -> str:
    """把用户输入转成安全的 ``%...%`` LIKE 模式（先转义 ``\\``，再转义 ``%`` / ``_``）。"""
    escaped = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class PendingDividendService(PendingDividendAssignMixin):
    """待划分分红的查询与人工裁定服务（批次 C，§4）。

    读侧方法在**本类**；写侧（assign / batch_* / ignore / reopen）来自
    ``PendingDividendAssignMixin``（``dividend_pending_assign.py``）。

    排序**固定** ``created_at DESC, id DESC``（不提供 ``sort`` 参数，D-7）；列表筛选
    ``status`` / ``label``（精确）/ ``q``（证券代码或名称 ilike）；分页复用
    ``services.base.paged``。
    """

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
            like = _like_pattern(q_kw)
            stmt = stmt.join(Security, Security.id == SecurityDividendPending.master_id)
            conditions.append(
                or_(
                    Security.code.ilike(like, escape=_LIKE_ESCAPE),
                    Security.name.ilike(like, escape=_LIKE_ESCAPE),
                )
            )
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
            # S20：不要手写 `pending + assigned + ignored` —— 枚举新增取值时会出现
            # 「列表有行、汇总 total 不含」的口径分裂；直接对全枚举计数求和。
            "total": sum(counts.values()),
            "labels": labels,
        }

    # ------------------------------------------------------------------ #
    # 内部实现（读侧）
    # ------------------------------------------------------------------ #
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

        ``planLabel`` / ``resolvedPeriodLabel``（S11）由**后端**产出（复用
        ``dividend_period.plan_label`` / ``period_label``），与 ``/{master_id}/dividends``
        同口径——前端不再自行拼「YYYY QX · 类型中文」，避免同一报告期两处文案不一致。
        ``resolvedPeriodLabel`` 仅对已裁定行有值（PENDING 行报告期未知，由前端给建议值）。
        """
        resolved_year = row.resolved_report_year
        resolved_quarter = row.resolved_report_quarter
        resolved_period = row.resolved_period_type
        return {
            "id": row.id,
            "masterId": row.master_id,
            "code": sec.code if sec else None,
            "name": sec.name if sec else None,
            "exchange": sec.exchange if sec else None,
            "dividendLabel": row.dividend_label,
            "cashPerShare": row.cash_per_share,
            "planLabel": plan_label(row.cash_per_share),
            "resolvedPeriodLabel": (
                period_label(resolved_year, resolved_quarter, resolved_period)
                if resolved_year is not None
                and resolved_quarter is not None
                and resolved_period
                else None
            ),
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
