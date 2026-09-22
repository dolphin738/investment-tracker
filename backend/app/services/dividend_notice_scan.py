"""每日公告扫描与巨潮历史分红采集服务（方案 §5，系统任务 DIVIDEND_NOTICE_SCAN）。

链路（§5.2）：分类 4 公告接口按自然日拉全市场公告 → 标题二筛得命中证券 → 按纯数字
``symbol`` 调分类 3 明细源（巨潮 ``stock_dividend_cninfo``，由 settings.
``dividend_detail_source_interface_id`` 配置）拉该股**全历史**分红 → 逐行映射
（``dividend_cninfo_parse``）→ 真 5 年裁剪 → 按唯一键
``(master_id, report_year, report_quarter, period_type)`` upsert。

要点：
- 公司公告接口可配置化（§5.4）：读 ``announcement_source_interface_id``（存在性 + 分类 4
  + enabled 三重校验，fail closed 不静默回退）；未配置回退分类 4 priority 升序首个。
  ``symbol=财务报告`` 一级预过滤，**不得**按公告类型列过滤；缺失/停用 → fail fast。
- 标题二筛白名单 = 代码常量（``_TITLE_*_RE``），改模式须补单测。§5.5 起候选放宽为
  「命中分红正则 ∧ 非 cancel」（旧口径要求含「特别|中期」，会漏掉普通年度分红）。
- 巨潮逐只调用复用 ``call_interface_raw``（串行 + 限流）；响应无代码列，证券代码取
  自参数 ``code``（与旧新浪路径口径一致）。
- upsert = 先按唯一键定位（命中即更新）→ 未命中经 ``_westward_dup`` 护栏后插入；
  取消公告把该 master 的 PROPOSED 行置 REJECTED。
- 按证券独立 commit；单只失败 rollback 续下一只（断点即数据本身）；变更集重算。
  **注意**：``rollback()`` 会 expire 会话内全部 ORM 实例，故失败后必须重新解析
  ``detail``（``NoticeMetaMixin._re_resolve_detail_after_rollback``），否则下一只读
  ``detail.params`` 会触发同步惰性加载 → MissingGreenlet 连锁失败。

**模块拆分（§6.3）**：公告标题二筛（``_TITLE_*_RE`` / ``_classify_notices``）与选源 + 重解析
韧性（``_settings`` / ``_provider_enabled`` / ``_resolve_notice_itf`` / ``_resolve_detail_itf`` /
``_re_resolve_*`` / ``_master_code_map``）已抽到 ``dividend_notice_meta.py`` 的
``NoticeMetaMixin``；本类继承之，私有方法访问口径不变。本模块只保留**落库主流程与 upsert**。
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Any, Optional

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import QuoteInterface, SecurityDividend
from app.models.dividend_yield import DEFAULT_DIVIDEND_RETENTION_YEARS
from app.models.enums import DividendStatus
from app.services.dividend_cninfo_parse import (
    CninfoDividendRow,
    KNOWN_LABELS,
    parse_cninfo_row_ex,
    parse_pending_row,
    retention_cutoff_year,
)
from app.services.dividend_notice_meta import NoticeMetaMixin
from app.services.dividend_pending import stage_pending
from app.services.dividend_yield_refresh import refresh_yields_for_masters
from app.services.market_data_sync import MarketDataSyncService

logger = logging.getLogger(__name__)


def _bump(stats: dict, key: str, n: int = 1) -> None:
    """统计计数累加（键缺失按 0 起算，兼容调用方自带的精简键集）。"""
    stats[key] = stats.get(key, 0) + n


# scan() / seed() 初始统计键集（fetch_and_upsert_master 只累加其中若干键）。
# 两入口键集必须完全一致，否则摘要会缺桶——tests 有「两入口 stats 键集相等」用例守护。
# seed 模块另定义一份独立常量（非 import）正是为了让「单侧加键」被该用例捕获。
_STATS_KEYS: frozenset = frozenset({
    "rows", "hits", "new", "upd", "anchor", "skip",
    "no_period", "unknown_label", "collision", "window", "skipped", "staged",
})

# 失败占比阈值（行动项 8，设计 §6.2）。逐只容错是「单只异常 → rollback 续下一只」；但
# 整轮失败率超过该阈值即判定为「上游整体失效」——必须**冒泡**（RuntimeError）让 scheduler
# 记 FAILED，而非把上万只吞成 skipped、摘要仍报「扫描完成」，这是本链路最危险的失败模式。
# 取 0.5：单只偶发失败（远低于半数）仍按容错续跑；半数以上失败几乎只可能来自上游整体不可用。
_FAILURE_RATIO_RAISE = 0.5


class DividendNoticeScanService(NoticeMetaMixin):
    """公告扫描 + 巨潮历史分红采集（复用 market_data_sync 既有分派机制）。

    选源 / 二筛 / 重解析能力来自 ``NoticeMetaMixin``（``dividend_notice_meta.py``）；
    本类只负责落库主流程与 upsert。
    """

    def __init__(self, session) -> None:
        self.session = session
        self._mds = MarketDataSyncService(session)
        # 跨证券聚合未收录标签，整轮结束后由 scan()/seed() 打**一条** WARNING
        self._unknown_label_counts: Counter = Counter()

    async def scan(self, cfg: Any) -> str:
        """每日公告扫描 + 巨潮历史分红采集（§5 全流程）。"""
        day = today_app_tz()
        # 第一步：公司公告接口（§5.4 可配置化）；缺失/停用 → fail fast
        notice_itf = await self._resolve_notice_itf(await self._settings())
        params = {"symbol": "财务报告", "date": day.strftime("%Y%m%d")}
        # 异常计失败（≥3 发站内信）已下沉到 call_interface_raw（P1-4），此处不再手工接线
        notice_rows = await self._mds.call_interface_raw(notice_itf, params, None)

        stats = {k: 0 for k in _STATS_KEYS}
        stats["rows"] = len(notice_rows)  # 公告条数（其余键含义见 _STATS_KEYS 定义处）
        candidate_mids: set[str] = set()
        cancel_mids: set[str] = set()
        events = await self._classify_notices(notice_itf, notice_rows, stats)
        for mid, kind in events:
            if kind == "candidate":
                candidate_mids.add(mid)
            elif kind == "cancel":
                cancel_mids.add(mid)

        # 存量 PROPOSED 所涉证券并入复查集合。新链路不再写 SPECIAL，故放宽为
        # 「不限 period_type」（与 ``_reject_proposed`` 同口径）。
        proposed_mids = set(
            (
                await self.session.execute(
                    select(SecurityDividend.master_id)
                    .where(SecurityDividend.status == DividendStatus.PROPOSED)
                    .distinct()
                )
            ).scalars().all()
        )
        all_mids = candidate_mids | cancel_mids | proposed_mids
        sec_code = await self._master_code_map(all_mids)
        settings = await self._settings()
        detail = await self._resolve_detail_itf(settings)
        retention_years = (
            settings.dividend_retention_years
            if settings is not None and settings.dividend_retention_years is not None
            else DEFAULT_DIVIDEND_RETENTION_YEARS
        )
        changed: set[str] = set()

        # 按证券独立处理 + commit（断点即数据本身）
        for idx, mid in enumerate(sorted(all_mids), 1):
            code = sec_code.get(mid)
            if not code:
                continue
            is_cancel = mid in cancel_mids
            # snapshot：rollback 会丢弃该只已累加的计数，须回退——
            # 摘要须等于实际落库结果，否则运维按摘要对账会偏大。
            snapshot = dict(stats)
            try:
                dirty = False
                if is_cancel and await self._reject_proposed(mid):
                    _bump(stats, "upd")
                    dirty = True
                # 取消公告本身不触发采集（旧口径同：取消路径只置 REJECTED）；
                # 同一证券若另有候选公告，仍须照常拉全历史。
                want_fetch = (mid in candidate_mids) or (not is_cancel)
                if want_fetch and detail is not None:
                    if await self.fetch_and_upsert_master(mid, code, detail, stats, retention_years):
                        dirty = True
                await self.session.commit()
                if dirty:
                    changed.add(mid)  # 仅提交成功后计入变更集
            except Exception:  # 单证券失败：rollback 续下一只（断点即数据本身，§5.2）
                logger.warning(
                    "公告扫描单只失败 master_id=%s（rollback 续下一只）", mid, exc_info=True
                )
                await self.session.rollback()
                stats.update(snapshot)
                _bump(stats, "skipped")
                # rollback() 会 expire 会话内实例 → detail 过期；须重新解析，否则下一只
                # 读 detail.params / detail.name 会触发同步惰性加载 → MissingGreenlet，
                # 把「源失效」伪装成「每只都失败」（详见
                # ``NoticeMetaMixin._re_resolve_detail_after_rollback``）。明细源本就缺失时无需重解析。
                if detail is not None:
                    # 源已失效则 fail fast raise；过程异常（DB 抖动）记日志续下一只（L-3）
                    detail = await self._reresolve_detail_safe(idx, len(all_mids)) or detail

        # 失败占比过高 → 冒泡（行动项 8，§6.2）：使 scheduler 记 FAILED 而非 SUCCESS。
        # 逐只容错只针对单只偶发失败；整体失败率过高必须终止，否则上游整体失效会被伪装成
        # 「扫描完成、只是失败几只」。total==0（无候选）时不做除法、也不判失败。
        total = len(all_mids)
        if total > 0 and stats["skipped"] / total > _FAILURE_RATIO_RAISE:
            raise RuntimeError(
                f"公告扫描失败占比过高：{stats['skipped']}/{total} 只失败"
                f"（阈值 {_FAILURE_RATIO_RAISE:.0%}），疑似上游整体失效，终止并标记 FAILED"
            )

        # 未收录标签聚合告警：整轮仅一条（样例取出现频次最高的 3 种），避免逐行 WARN 风暴
        if self._unknown_label_counts:
            samples = [label for label, _ in self._unknown_label_counts.most_common(3)]
            # 总量读 stats["unknown_label"]（随快照 rollback，口径与摘要一致）；Counter
            # 只用于算样例与「去重种数」。否则失败 rollback 后 Counter 未回退，会略大于落库行数。
            logger.warning(
                "巨潮「分红类型」未收录标签共 %d 行、去重 %d 种，样例=%r",
                stats["unknown_label"],
                len(self._unknown_label_counts), samples[:3],
            )

        # 完成后：仅变更集重算（§5.2 末步 / §7 变更集重算）
        await refresh_yields_for_masters(self.session, list(changed))
        await self.session.commit()
        no_source = detail is None and bool(candidate_mids | proposed_mids)
        note = "；明细源缺失跳过逐只采集" if no_source else ""
        return (
            f"公告扫描完成{note}：公告{stats['rows']}条/命中{stats['hits']}；"
            f"分红行新写{stats['new']}/更新{stats['upd']}；"
            f"窗口外{stats['window']}/无派息{stats['skip']}/无报告期{stats['no_period']}"
            f"/待划分{stats['staged']}；"
            f"标签撞键{stats['collision']}/未知标签{stats['unknown_label']}；"
            f"重算{len(changed)}只；去重跳过{stats['anchor']}；失败{stats['skipped']}只"
        )

    async def fetch_and_upsert_master(
        self, mid: str, code: str, detail: QuoteInterface, stats: dict,
        retention_years: int | None = None,
    ) -> bool:
        """单只证券：调巨潮拉全历史 → 按 §5.3 映射 → 近 N 年裁剪（years 取配置，默认 5）→ upsert。返回是否有变更。

        供每日 ``scan()`` 与首跑播种（§5.7）共用：代码取参数 ``code`` 的纯数字部分
        （响应无代码列），遍历**全部返回行**（不再是「取当天那一条」）。

        「现金 >0 但报告时间不可解析」（``no_period``）的行落 staging（``stage_pending``）
        待人工划分；staging **不计入 changed**（返回值只反映主表 ``security_dividends``
        写入；调用方不得据此把 mid 加入派生快照重算集）。

        未收录标签计数聚合在 ``self._unknown_label_counts``（每实例一个），由 scan()/seed()
        在整轮结束后打**一条**聚合 WARNING（避免逐行 WARN 淹没真正告警）。**只统计活过 5 年
        留存窗的行**，避免窗口外行同时计入 ``window`` 与 ``unknown_label`` 两桶。
        """
        digits = re.sub(r"\D", "", code)  # sh600519 → 600519
        params = {**(detail.params or {}), "symbol": digits}
        rows = await self._mds.call_interface_raw(detail, params, None)
        years = (
            retention_years
            if retention_years is not None
            else DEFAULT_DIVIDEND_RETENTION_YEARS
        )
        cutoff_year = retention_cutoff_year(today_app_tz(), years)  # 真 N 年：[cur-years+1, cur]
        dirty = False
        for r in rows:
            parsed, skip_reason = parse_cninfo_row_ex(r)
            if parsed is None:  # 纯送转（no_cash）/ 报告期不可解析（no_period）
                _bump(stats, "skip" if skip_reason == "no_cash" else "no_period")
                if skip_reason == "no_period":
                    # 现金 >0 但「报告时间」不可解析 → 落 staging 待人工划分（§3.7）。
                    # 纯送转（no_cash）与窗口外行不入队；staging **不计入 changed**
                    # （调用方不得据此把 mid 加入派生快照重算集，见 _STATS_KEYS 说明）。
                    if await stage_pending(self.session, mid, parse_pending_row(r)):
                        _bump(stats, "staged")
                continue
            if parsed.report_year < cutoff_year:  # §9.3-A3：对齐 retention_cleanup
                _bump(stats, "window")
                continue
            # 活过留存窗后，未收录标签（含空/None）→ 落 OTHER，原文已存入 dividend_label，
            # 仅按行数累加 unknown_label；逐行 WARN 改为由 scan/seed 整轮聚合一次。
            if parsed.dividend_label not in KNOWN_LABELS:
                _bump(stats, "unknown_label")
                self._unknown_label_counts[parsed.dividend_label or ""] += 1
            if await self._upsert_one(mid, parsed, detail.name, stats):
                dirty = True
        return dirty

    async def _upsert_one(
        self, mid: str, row: CninfoDividendRow, source: str, stats: dict
    ) -> bool:
        """按唯一键定位后更新 / 未命中则插入；返回是否有变更。"""
        existing = await self._locate_cell(mid, row)
        if existing is not None:
            # 撞键护栏（批次 A）：命中唯一键且新旧「分红类型」标签均非空且不等 →
            # **整行不更新**（保留旧值，不覆盖）。四个条件缺一不可——``old_label``
            # 为空必须豁免，否则迁移后存量 NULL 行会被全表判为撞键。
            old_label = existing.dividend_label
            new_label = row.dividend_label
            if old_label and new_label and old_label != new_label:
                _bump(stats, "collision")
                logger.warning(
                    "分红撞键保留旧值（不覆盖）：master=%s 格=(%dQ%d, %s) 旧标签=%r 新标签=%r；"
                    "旧除权日=%s 新除权日=%s",
                    mid, row.report_year, row.report_quarter, row.period_type.value,
                    old_label, new_label, existing.ex_dividend_date, row.ex_dividend_date,
                )
                return False
            # 标签写入口径：仅当「本次标签非空」才用新值，否则保留旧标签。这样：
            # old=None+new='X' → 回填 ✅；old='X'+new=None → 保留旧 ✅（避免新标签为空
            # 把旧标签覆盖成 NULL 造成抖动）；old/new 均非空且不等已在上面判撞键。
            effective_label = new_label if new_label is not None else old_label
            # 定位后更新：目标格命中即刷新金额/日期/送转/source/原文标签。
            # 取舍见 ``_westward_dup``——去重护栏只作用于「未命中目标格」的新增路径。
            dirty = (
                existing.cash_per_share != row.cash_per_share
                or existing.ex_dividend_date != row.ex_dividend_date
                or existing.record_date != row.record_date
                or existing.announcement_date != row.announcement_date
                or existing.bonus_share_ratio != row.bonus_share_ratio
                or existing.convert_ratio != row.convert_ratio
                or existing.status != row.status
                or existing.source != source
                or existing.dividend_label != effective_label
            )
            existing.cash_per_share = row.cash_per_share
            existing.ex_dividend_date = row.ex_dividend_date
            existing.record_date = row.record_date
            existing.announcement_date = row.announcement_date
            existing.bonus_share_ratio = row.bonus_share_ratio
            existing.convert_ratio = row.convert_ratio
            existing.status = row.status
            existing.source = source
            existing.dividend_label = effective_label
            if dirty:
                _bump(stats, "upd")
            return dirty
        if await self._westward_dup(
            mid, row.ex_dividend_date, row.report_year, row.report_quarter,
            row.cash_per_share, source,
        ):
            _bump(stats, "anchor")
            return False
        self.session.add(
            SecurityDividend(
                master_id=mid,
                report_year=row.report_year,
                report_quarter=row.report_quarter,
                period_type=row.period_type,
                cash_per_share=row.cash_per_share,
                status=row.status,
                ex_dividend_date=row.ex_dividend_date,
                announcement_date=row.announcement_date,
                record_date=row.record_date,
                source=source,
                bonus_share_ratio=row.bonus_share_ratio,
                convert_ratio=row.convert_ratio,
                dividend_label=row.dividend_label,
            )
        )
        _bump(stats, "new")
        return True

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


async def run_dividend_notice_scan(cfg: Any) -> str:
    """模块级 handler：每日公告扫描 + 巨潮历史分红采集（§5 系统任务）。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendNoticeScanService(session).scan(cfg)
        await session.commit()
    return result
