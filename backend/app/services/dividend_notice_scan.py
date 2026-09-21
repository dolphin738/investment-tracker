"""每日公告扫描与巨潮历史分红采集服务（方案 §5，系统任务 DIVIDEND_NOTICE_SCAN）。

链路（§5.2）：分类 4 公告接口按自然日拉全市场公告 → 标题二筛得命中证券 → 按纯数字
``symbol`` 调分类 3 明细源（巨潮 ``stock_dividend_cninfo``，由 settings.
``dividend_detail_source_interface_id`` 配置）拉该股**全历史**分红 → 逐行映射
（``dividend_cninfo_parse``）→ 真 5 年裁剪 → 按唯一键
``(master_id, report_year, report_quarter, period_type)`` upsert。

要点：
- 公告源可配置化（§5.4）：读 ``announcement_source_interface_id``（存在性 + 分类 4
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
  ``detail``（``_re_resolve_detail_after_rollback``），否则下一只读 ``detail.params``
  会触发同步惰性加载 → MissingGreenlet 连锁失败。
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Any, Optional

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
)
from app.models.enums import DividendStatus
from app.services.dividend_cninfo_parse import (
    CninfoDividendRow,
    KNOWN_LABELS,
    parse_cninfo_row_ex,
    retention_cutoff_year,
)
from app.services.dividend_yield_refresh import refresh_yields_for_masters
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    NOTICE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    _row_get,
    infer_exchange,
)
from app.services.response_fields import (
    SLOT_CODE,
    index_by_slot,
    resolve_fields,
)

# —— 标题正则二筛白名单（§5.5；改模式须补单测，禁止删改关键词）——
_TITLE_DIVIDEND_RE = re.compile(r"分红|派息|权益分派|利润分配|分配方案")
_TITLE_CANCEL_RE = re.compile(r"取消|终止")

# 东财公告 SDK（stock_notice_report）的公告标题列：展示字段（无 slot，不参与同步
# 契约），仅作标题二筛取值来源；代码列已收敛到 response_fields 的 code 槽。
_COL_NOTICE_TITLE = "公告标题"

logger = logging.getLogger(__name__)


def _bump(stats: dict, key: str, n: int = 1) -> None:
    """统计计数累加（键缺失按 0 起算，兼容调用方自带的精简键集）。"""
    stats[key] = stats.get(key, 0) + n


# scan() / seed() 初始统计键集（fetch_and_upsert_master 只累加其中若干键）。
# 两入口键集必须完全一致，否则摘要会缺桶——tests 有「两入口 stats 键集相等」用例守护。
# seed 模块另定义一份独立常量（非 import）正是为了让「单侧加键」被该用例捕获。
_STATS_KEYS: frozenset = frozenset({
    "rows", "hits", "new", "upd", "anchor", "skip",
    "no_period", "unknown_label", "collision", "window", "skipped",
})


class DividendNoticeScanService:
    """公告扫描 + 巨潮历史分红采集（复用 market_data_sync 既有分派机制）。"""

    def __init__(self, session) -> None:
        self.session = session
        self._mds = MarketDataSyncService(session)
        # 跨证券聚合未收录标签，整轮结束后由 scan()/seed() 打**一条** WARNING
        self._unknown_label_counts: Counter = Counter()

    async def _settings(self) -> Optional[DividendYieldSettings]:
        return (
            await self.session.execute(select(DividendYieldSettings).limit(1))
        ).scalar_one_or_none()

    async def _provider_enabled(self, itf: QuoteInterface) -> bool:
        """提供方启用校验（ADR-002 #1 修复口径：所有选源路径须过滤提供方 enabled，
        否则停用提供方但其下接口仍 enabled 时会被照常选用）。"""
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        return provider is not None and provider.enabled

    async def _resolve_detail_itf(
        self, settings: Optional[DividendYieldSettings]
    ) -> Optional[QuoteInterface]:
        """解析明细源：存在性 + 分类 3 + 接口/提供方 enabled 校验；失败返回 None（记告警跳过）。"""
        iid = settings.dividend_detail_source_interface_id if settings else None
        if not iid:
            return None
        itf = await self.session.get(QuoteInterface, iid)
        if (
            itf is None
            or itf.category_id != DIVIDEND_LIST_CAT_ID
            or not itf.enabled
            or not await self._provider_enabled(itf)
        ):
            return None
        return itf

    async def _re_resolve_detail_after_rollback(self) -> QuoteInterface:
        """``rollback()`` 之后重新解析明细源（§5.2「失败续下一只」的前置条件）。

        ``Session.rollback()`` 在有活动事务时会 expire 会话内**全部** ORM 实例（与
        ``expire_on_commit=False`` 无关，无活动事务时为空操作）。随之过期后，下一只
        再读 ``detail.params`` / ``detail.name`` 会触发**同步**惰性加载 →
        ``MissingGreenlet``；该异常被单证券 ``except Exception`` 吞掉计入失败 → 再次
        ``rollback()`` → 其后**每一只**连锁失败，「失败续下一只」形同虚设（4609 只
        串行时几乎必然触发）。故失败路径必须重新解析（仅失败路径，避免无谓查询）。

        重解析为 ``None``（明细源执行中被停用/删除/提供方停用）→ **fail fast raise**：
        否则「源失效」会被伪装成「每只都失败」，掩盖真实原因。

        Raises:
            RuntimeError: 明细源在本次执行过程中变为不可用。
        """
        fresh = await self._resolve_detail_itf(await self._settings())
        if fresh is None:
            raise RuntimeError(
                "明细源（巨潮历史分红）在本次执行过程中变为不可用"
                "（接口被停用/删除、分类不符或提供方被停用），fail fast 终止："
                "剩余证券无法继续逐只采集"
            )
        return fresh

    async def _reresolve_detail_safe(self, idx: int, total: int) -> Optional[QuoteInterface]:
        """失败后重解析明细源（L-3 韧性）。

        - **真失效**：``_re_resolve_detail_after_rollback`` 抛 ``RuntimeError("…变为不可用")``
          → 原样 raise，fail fast 终止（否则「源失效」被伪装成「每只都失败」）。
        - **过程异常**：重解析本身抛其它异常（DB 瞬时抖动）→ 记日志返回 ``None``，
          按失败续下一只，**不终止整轮**——剩余证券在 DB 恢复后经下一轮自愈。
        """
        try:
            return await self._re_resolve_detail_after_rollback()
        except Exception as e:
            if isinstance(e, RuntimeError) and "变为不可用" in str(e):
                raise
            logger.warning(
                "扫描第 %d/%d 只重解析明细源过程异常（按失败续下一只）：%s", idx, total, e,
            )
            return None

    async def _resolve_notice_itf(
        self, settings: Optional[DividendYieldSettings]
    ) -> QuoteInterface:
        """解析公告源（§5.4）：优先读全局配置，未配置回退分类 4 priority 最小。

        - 配置了 ``announcement_source_interface_id``：校验（存在性 + 分类 4 + 接口/
          提供方 enabled），任一不符 → fail fast raise，**不静默回退**——把失效/非公告
          接口悄悄换成其他分类 4 接口会掩盖配置错误（§5.4 fail closed 口径）。
        - 未配置：回退分类 4 enabled 接口按 priority 升序首个；无可用接口 → fail fast。
        """
        iid = settings.announcement_source_interface_id if settings else None
        if iid:
            itf = await self.session.get(QuoteInterface, iid)
            if (
                itf is None
                or itf.category_id != NOTICE_CAT_ID
                or not itf.enabled
                or not await self._provider_enabled(itf)
            ):
                raise RuntimeError(
                    "配置的公司公告接口不存在、分类不符或已停用，fail fast 跳过本次公告扫描"
                )
            return itf
        notice_itfs = await self._mds._interfaces_for_category(NOTICE_CAT_ID)
        if not notice_itfs:
            raise RuntimeError("公司公告接口（分类4）缺失或已停用，fail fast 跳过本次公告扫描")
        return notice_itfs[0]

    async def scan(self, cfg: Any) -> str:
        """每日公告扫描 + 巨潮历史分红采集（§5 全流程）。"""
        day = today_app_tz()
        # 第一步：公告源（§5.4 可配置化）；缺失/停用 → fail fast
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
        detail = await self._resolve_detail_itf(await self._settings())
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
                    if await self.fetch_and_upsert_master(mid, code, detail, stats):
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
                # ``_re_resolve_detail_after_rollback``）。明细源本就缺失时无需重解析。
                if detail is not None:
                    # 源已失效则 fail fast raise；过程异常（DB 抖动）记日志续下一只（L-3）
                    detail = await self._reresolve_detail_safe(idx, len(all_mids)) or detail

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
            f"窗口外{stats['window']}/无派息{stats['skip']}/无报告期{stats['no_period']}；"
            f"标签撞键{stats['collision']}/未知标签{stats['unknown_label']}；"
            f"重算{len(changed)}只；去重跳过{stats['anchor']}；失败{stats['skipped']}只"
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
        """公告行标题二筛 + 证券主键归一；返回 [(master_id, kind)]。

        kind: "candidate"（分红相关且非取消）/ "cancel"（分红相关且含取消|终止）。
        公告标题列取 ``公告标题``；取不到（行非 dict / 列缺失）退化为对整行文本
        ``str(row)`` 跑同一正则（不臆造列名，§5.2 取舍）。
        """
        if not rows:
            return []
        total = len(rows)
        # code 槽取 resolve_fields 默认：公告用途（cat=4）按 category_id 分派候选
        # 顺序 = [中文列名「代码」优先, 接口配置的代码列]；required 槽缺失整行丢弃。
        compiled = resolve_fields(itf)
        rows, dropped = self._mds._filter_required_rows(itf, compiled, rows)
        if not rows:
            # 整批被 required 丢弃 = 无可用响应：复用既有 consecutive_failures/alerted 通道
            await self._mds._note_required_drops(itf, dropped, total)
            return []
        code_field = index_by_slot(compiled).get(SLOT_CODE)
        codes = set()
        for r in rows:
            raw = code_field.get(r) if code_field else None
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
            # §5.5：候选 = 命中分红正则 ∧ 非 cancel（不再要求含「特别|中期」，
            # 否则普通年度分红公告会被整批漏掉）。
            is_candidate = is_div and not is_cancel
            if not (is_candidate or is_cancel):
                continue
            raw = code_field.get(r) if code_field else None
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

    async def fetch_and_upsert_master(
        self, mid: str, code: str, detail: QuoteInterface, stats: dict
    ) -> bool:
        """单只证券：调巨潮拉全历史 → 按 §5.3 映射 → 5 年裁剪 → upsert。返回是否有变更。

        供每日 ``scan()`` 与首跑播种（§5.7）共用：代码取参数 ``code`` 的纯数字部分
        （响应无代码列），遍历**全部返回行**（不再是「取当天那一条」）。

        未收录标签计数聚合在 ``self._unknown_label_counts``（每实例一个），由 scan()/seed()
        在整轮结束后打**一条**聚合 WARNING（避免逐行 WARN 淹没真正告警）。**只统计活过 5 年
        留存窗的行**，避免窗口外行同时计入 ``window`` 与 ``unknown_label`` 两桶。
        """
        digits = re.sub(r"\D", "", code)  # sh600519 → 600519
        params = {**(detail.params or {}), "symbol": digits}
        rows = await self._mds.call_interface_raw(detail, params, None)
        cutoff_year = retention_cutoff_year(today_app_tz())  # 真 5 年：[cur-4, cur]
        dirty = False
        for r in rows:
            parsed, skip_reason = parse_cninfo_row_ex(r)
            if parsed is None:  # 纯送转（no_cash）/ 报告期不可解析（no_period）
                _bump(stats, "skip" if skip_reason == "no_cash" else "no_period")
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
