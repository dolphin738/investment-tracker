"""每日公告扫描与特别分红补充服务（方案 §6.8，系统任务 DIVIDEND_NOTICE_SCAN）。

东财按报告期接口（§6.1）系统性遗漏「无报告期归属的特别分红」（茅台实证，附录 A.6）。
本服务用分类 4「沪深京 A 股公告」接口（SDK ``stock_notice_report``）按自然日扫描标题，
发现候选特别分红后经补充源（settings.``dividend_detail_source_interface_id``，新浪
``stock_history_dividend_detail``）逐只补充金额与实施事实，写入 SPECIAL 分红行。

忠实实现 §6.8，不重写行情请求：
- 公告源 = 分类 4 enabled 接口（``_interfaces_for_category``），``symbol=财务报告`` 一级
  分类预过滤，**不得**按公告类型列过滤；公告接口缺失/停用 → fail fast raise。
- 标题正则二筛白名单 = 代码常量（``_TITLE_*_RE``），改模式须补单测。
- 新浪逐只补充 = 复用 ``_call_interface_raw``（串行 + ``_RATE_LIMITER`` 限速）。
- SPECIAL 写入 = 西向去重 + PROPOSED→PAID + 取消置 REJECTED + 存量复查（§6.8 双向去重）。
- 按证券独立 commit；单证券失败 rollback 续下一只（断点即数据本身）；变更集重算。
"""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    Security,
    SecurityDividend,
)
from app.models.enums import DividendStatus, ReportPeriodType
from app.core.date_utils import parse_date
from app.services.dividend_yield_refresh import refresh_yields_for_masters
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    NOTICE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    _row_get,
    infer_exchange,
)

# —— 标题正则二筛白名单（§6.8 第二步；改模式须补单测，禁止删改关键词）——
_TITLE_DIVIDEND_RE = re.compile(r"分红|派息|权益分派|利润分配|分配方案")
_TITLE_SPECIAL_RE = re.compile(r"特别|中期")
_TITLE_CANCEL_RE = re.compile(r"取消|终止")

# 东财公告 SDK（stock_notice_report）重命名后的列名（见 akshare stock_notice.py）
_COL_NOTICE_CODE = "代码"
_COL_NOTICE_TITLE = "公告标题"
# 新浪分红 SDK（stock_history_dividend_detail）列名（见 akshare stock_finance_sina.py）
_COL_SINA_ANN = "公告日期"
_COL_SINA_CASH = "派息"
_COL_SINA_PROGRESS = "进度"
_COL_SINA_EXDATE = "除权除息日"


def _anchor(ann: date) -> tuple[int, int]:
    """公告日期 → (report_year, report_quarter)：'SPECIAL 落格锚点'（§2.1 决策 A6）。

    年 = 公告年；季 = 公告月份所在日历季度（``ceil(月/3)``）。
    """
    return ann.year, (ann.month - 1) // 3 + 1


def _sina_cash(raw: Any) -> Optional[Decimal]:
    """新浪 '派息'（每 10 股派 X 元）→ 每股金额（÷10）。"""
    if raw in (None, "", "-", "nan", "None"):
        return None
    try:
        return Decimal(str(raw).strip()) / Decimal("10")
    except (InvalidOperation, ValueError, TypeError):
        return None


class DividendNoticeScanService:
    """公告扫描 + 特别分红补充（复用 market_data_sync 既有分派机制）。"""

    def __init__(self, session) -> None:
        self.session = session
        self._mds = MarketDataSyncService(session)

    async def _settings(self) -> Optional[DividendYieldSettings]:
        return (
            await self.session.execute(select(DividendYieldSettings).limit(1))
        ).scalar_one_or_none()

    async def _resolve_detail_itf(
        self, settings: Optional[DividendYieldSettings]
    ) -> Optional[QuoteInterface]:
        """解析补充源：存在性 + 分类 3 + enabled 三重校验；失败返回 None（记告警跳过）。"""
        iid = settings.dividend_detail_source_interface_id if settings else None
        if not iid:
            return None
        itf = await self.session.get(QuoteInterface, iid)
        if itf is None or itf.category_id != DIVIDEND_LIST_CAT_ID or not itf.enabled:
            return None
        return itf

    async def scan(self, cfg: Any) -> str:
        """每日公告扫描 + 特别分红补充（§6.8 全流程）。"""
        day = today_app_tz()
        # 第一步：公告源 = 分类 4 enabled 接口；缺失/停用 → fail fast
        notice_itfs = await self._mds._interfaces_for_category(NOTICE_CAT_ID)
        if not notice_itfs:
            raise RuntimeError("公司公告接口（分类4）缺失或已停用，fail fast 跳过本次公告扫描")
        notice_itf = notice_itfs[0]

        params = {"symbol": "财务报告", "date": day.strftime("%Y%m%d")}
        # 异常计失败（≥3 发站内信）已下沉到 _call_interface_raw（P1-4），此处不再手工接线
        notice_rows = await self._mds._call_interface_raw(notice_itf, params, None)

        # 统计汇总
        stats = {
            "rows": len(notice_rows),
            "hits": 0,  # 动作命中行数（候选特别分红 + 取消/终止）
            "special_new": 0,
            "special_upd": 0,
            "skipped": 0,  # 单证券失败续下一只数
        }
        candidate_mids: set[str] = set()
        cancel_mids: set[str] = set()

        # 第二步 + 命中证券主键归一（并行解析公告行标题与代码）
        events = await self._classify_notices(notice_itf, notice_rows, stats)
        for mid, kind in events:
            if kind == "candidate":
                candidate_mids.add(mid)
            elif kind == "cancel":
                cancel_mids.add(mid)

        # 第三/五步：存量 PROPOSED SPECIAL 所涉证券并入复查集合
        proposed_mids = set(
            (
                await self.session.execute(
                    select(SecurityDividend.master_id)
                    .where(
                        SecurityDividend.period_type == ReportPeriodType.SPECIAL,
                        SecurityDividend.status == DividendStatus.PROPOSED,
                    )
                    .distinct()
                )
            ).scalars().all()
        )
        all_mids = candidate_mids | cancel_mids | proposed_mids
        sec_code = await self._master_code_map(all_mids)
        detail = await self._resolve_detail_itf(await self._settings())
        changed: set[str] = set()

        # 按证券独立处理 + commit（断点即数据本身）
        for mid in sorted(all_mids):
            code = sec_code.get(mid)
            if not code:
                continue
            is_candidate = mid in candidate_mids
            is_cancel = mid in cancel_mids
            try:
                changed.update(
                    await self._process_master(
                        mid, code, detail, is_candidate, is_cancel, day, stats
                    )
                )
                await self.session.commit()
            except Exception:  # 单证券失败：rollback 续下一只（断点即数据本身，§6.8）
                await self.session.rollback()
                stats["skipped"] += 1

        # 完成后：仅变更集重算（§6.8 末步 / §7 变更集重算）
        await refresh_yields_for_masters(self.session, list(changed))
        await self.session.commit()
        note = "；补充源缺失跳过逐只补充" if (detail is None and (candidate_mids | proposed_mids)) else ""
        return (
            f"公告扫描完成{note}：公告{stats['rows']}条/命中{stats['hits']}；"
            f"SPECIAL 新写{stats['special_new']}/更新{stats['special_upd']}；"
            f"重算{len(changed)}只；失败{stats['skipped']}只"
        )

    async def _master_code_map(self, mids: set[str]) -> dict[str, str]:
        """master_id → master code（带交易所前缀，如 sh600519）。"""
        if not mids:
            return {}
        rows = (
            await self.session.execute(select(Security).where(Security.id.in_(mids)))
        ).scalars().all()
        return {s.id: s.code for s in rows}

    async def _classify_notices(
        self, itf: QuoteInterface, rows: list[Any], stats: dict
    ) -> list[tuple[str, str]]:
        """对公告行做标题二筛 + 证券主键归一；返回 [(master_id, kind)]。

        kind: "candidate"（分红相关且含特别|中期）/ "cancel"（含取消|终止且分红）。
        公告标题列取 ``公告标题``；若拿不到（行非 dict / 列缺失），退化为对整行文本
        ``str(row)`` 跑同一正则（不臆造列名，§6.8 取舍）。
        """
        if not rows:
            return []
        # 证券代码 → master_id 映射（一次建表，逐行命中）
        codes = set()
        for r in rows:
            raw = _row_get(r, _COL_NOTICE_CODE)
            if raw is None:
                raw = _row_get(r, itf.resp_code_field)
            if raw is not None:
                codes.add(_normalize_master_code(str(raw), infer_exchange(str(raw))))
        code_map: dict[str, str] = {}
        if codes:
            sec_rows = (
                await self.session.execute(select(Security).where(Security.code.in_(codes)))
            ).scalars().all()
            code_map = {s.code: s.id for s in sec_rows}

        events: list[tuple[str, str]] = []
        for r in rows:
            text = _row_get(r, _COL_NOTICE_TITLE)
            if not text:
                text = str(r)  # 退化：整行文本跑标题正则（不臆造列名）
            text = str(text)
            is_div = bool(_TITLE_DIVIDEND_RE.search(text))
            is_cancel = is_div and bool(_TITLE_CANCEL_RE.search(text))
            is_candidate = is_div and bool(_TITLE_SPECIAL_RE.search(text))
            if not (is_candidate or is_cancel):
                continue
            raw = _row_get(r, _COL_NOTICE_CODE)
            if raw is None:
                raw = _row_get(r, itf.resp_code_field)
            if raw is None:
                continue
            code = _normalize_master_code(str(raw), infer_exchange(str(raw)))
            master_id = code_map.get(code)
            if master_id is None:  # 未命中证券主数据：记日志跳过
                continue
            stats["hits"] += 1
            if is_candidate:
                events.append((master_id, "candidate"))
            if is_cancel:
                events.append((master_id, "cancel"))
        return events

    async def _process_master(
        self,
        mid: str,
        code: str,
        detail: Optional[QuoteInterface],
        is_candidate: bool,
        is_cancel: bool,
        day: date,
        stats: dict,
    ) -> set[str]:
        """处理单一证券：取消置 REJECTED + 新浪逐只补充写 SPECIAL；返回变更 master 集。"""
        changed: set[str] = set()
        if is_cancel:
            if await self._reject_proposed(mid):
                stats["special_upd"] += 1
                changed.add(mid)

        # 存量复查或候选命中需查新浪补充源（金额 + 实施事实源）。
        # 判定：候选命中 或 该证券已有存量 PROPOSED SPECIAL（存量复查，§6.8）
        want_sina = is_candidate or await self._has_proposed(mid)
        if not want_sina or detail is None:
            return changed

        digits = re.sub(r"\D", "", code)
        params = {**(detail.params or {}), "symbol": digits}
        srows = await self._mds._call_interface_raw(detail, params, None)
        for r in srows:
            cash = _sina_cash(_row_get(r, _COL_SINA_CASH))
            if cash is None:
                continue
            progress = str(_row_get(r, _COL_SINA_PROGRESS) or "")
            ex_date = parse_date(_row_get(r, _COL_SINA_EXDATE))
            ann_raw = parse_date(_row_get(r, _COL_SINA_ANN))
            # 实施判定：进度含「实施」且除权日非空（§6.8）
            is_impl = "实施" in progress and ex_date is not None
            # announcement_date = 新浪行公告日期（实施行）或公告扫描命中日（§6.8）
            ann = ann_raw if (is_impl and ann_raw is not None) else day
            ry, rq = _anchor(ann)

            # 西向去重：已被东财报告期行覆盖则跳过（§6.8）
            if await self._westward_dup(mid, ex_date, ry, rq, cash):
                continue

            if is_impl:
                matched = await self._match_proposed(mid, cash)
                if matched is not None:
                    matched.status = DividendStatus.PAID
                    matched.ex_dividend_date = ex_date
                    matched.announcement_date = ann
                    matched.source = detail.name
                    stats["special_upd"] += 1
                    changed.add(mid)
                else:
                    # 西向去重已过，但同格已有 SPECIAL 行（不同额）则不再重复写
                    if await self._exists_anchor(mid, ry, rq):
                        continue
                    self.session.add(
                        self._new_special(mid, ry, rq, cash, DividendStatus.PAID, ex_date, ann, detail.name)
                    )
                    stats["special_new"] += 1
                    changed.add(mid)
            elif is_candidate:
                # 新浪只作「金额 + 实施事实」源，PROPOSED 发现以公告标题为准（§6.8）
                if await self._exists_anchor(mid, ry, rq):
                    continue
                self.session.add(
                    self._new_special(mid, ry, rq, cash, DividendStatus.PROPOSED, None, ann, detail.name)
                )
                stats["special_new"] += 1
                changed.add(mid)
        return changed

    def _new_special(
        self,
        mid: str,
        ry: int,
        rq: int,
        cash: Decimal,
        status: DividendStatus,
        ex_date: Optional[date],
        ann: date,
        source: str,
    ) -> SecurityDividend:
        """构造 SPECIAL 行（公告日期锚点落格，§2.1）。"""
        return SecurityDividend(
            master_id=mid,
            report_year=ry,
            report_quarter=rq,
            period_type=ReportPeriodType.SPECIAL,
            cash_per_share=cash,
            status=status,
            ex_dividend_date=ex_date,
            announcement_date=ann,
            source=source,
        )

    async def _westward_dup(self, mid, ex_date, ry, rq, cash) -> bool:
        """西向去重：同 master 已有「ex_date 相等」或「(ry,rq,cash) 全等」记录 → 跳过。"""
        if ex_date is not None:
            hit = (
                await self.session.execute(
                    select(SecurityDividend.id)
                    .where(
                        SecurityDividend.master_id == mid,
                        SecurityDividend.ex_dividend_date == ex_date,
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if hit is not None:
                return True
        hit = (
            await self.session.execute(
                select(SecurityDividend.id)
                .where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.report_year == ry,
                    SecurityDividend.report_quarter == rq,
                    SecurityDividend.cash_per_share == cash,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        return hit is not None

    async def _match_proposed(self, mid: str, cash: Decimal) -> Optional[SecurityDividend]:
        """PROPOSED→PAID：同 master + cash 相等匹配存量 PROPOSED SPECIAL；多行同额取 announcement_date 最近者。"""
        return (
            await self.session.execute(
                select(SecurityDividend)
                .where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.period_type == ReportPeriodType.SPECIAL,
                    SecurityDividend.status == DividendStatus.PROPOSED,
                    SecurityDividend.cash_per_share == cash,
                )
                .order_by(
                    SecurityDividend.announcement_date.desc().nulls_last(),
                    SecurityDividend.id.desc(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()

    async def _exists_anchor(self, mid: str, ry: int, rq: int) -> bool:
        """同 master 的 (ry, rq) 格是否已有 SPECIAL 行（防唯一键冲突）。"""
        hit = (
            await self.session.execute(
                select(SecurityDividend.id)
                .where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.report_year == ry,
                    SecurityDividend.report_quarter == rq,
                    SecurityDividend.period_type == ReportPeriodType.SPECIAL,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        return hit is not None

    async def _has_proposed(self, mid: str) -> bool:
        """该证券是否已有存量 PROPOSED SPECIAL 行（存量复查触发）。"""
        hit = (
            await self.session.execute(
                select(SecurityDividend.id)
                .where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.period_type == ReportPeriodType.SPECIAL,
                    SecurityDividend.status == DividendStatus.PROPOSED,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        return hit is not None

    async def _reject_proposed(self, mid: str) -> int:
        """取消/终止：对应存量 PROPOSED SPECIAL 行置 REJECTED；返回置位数。"""
        rows = (
            await self.session.execute(
                select(SecurityDividend).where(
                    SecurityDividend.master_id == mid,
                    SecurityDividend.period_type == ReportPeriodType.SPECIAL,
                    SecurityDividend.status == DividendStatus.PROPOSED,
                )
            )
        ).scalars().all()
        for r in rows:
            r.status = DividendStatus.REJECTED
        return len(rows)


async def run_dividend_notice_scan(cfg: Any) -> str:
    """模块级 handler：每日公告扫描 + 特别分红补充（§6.8 第 5 条系统任务）。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendNoticeScanService(session).scan(cfg)
        await session.commit()
    return result