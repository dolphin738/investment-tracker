"""每日公告扫描与特别分红补充服务（方案 §6.8，系统任务 DIVIDEND_NOTICE_SCAN）。

东财按报告期接口（§6.1）系统性遗漏「无报告期归属的特别分红」（茅台实证，附录 A.6）。
本服务用分类 4「沪深京 A 股公告」接口（SDK ``stock_notice_report``）按自然日扫描标题，
发现候选特别分红后经补充源（settings.``dividend_detail_source_interface_id``，新浪
``stock_history_dividend_detail``）逐只补充金额与实施事实，写入 SPECIAL 分红行。

忠实实现 §6.8，不重写行情请求：
- 公告源可配置化（§5.4/§6.8）：优先读全局配置 ``announcement_source_interface_id``
  （存在性 + 分类 4 + enabled 三重校验，fail closed 不静默回退）；未配置时回退分类 4
  enabled 接口按 priority 升序首个（``_interfaces_for_category``）。``symbol=财务报告``
  一级分类预过滤，**不得**按公告类型列过滤；公告接口缺失/停用 → fail fast raise。
- 标题正则二筛白名单 = 代码常量（``_TITLE_*_RE``），改模式须补单测。
- 新浪逐只补充 = 复用 ``_call_interface_raw``（串行 + ``_RATE_LIMITER`` 限速）。
- SPECIAL 写入 = 西向去重 + PROPOSED→PAID + 取消置 REJECTED + 存量复查（§6.8 双向去重）。
- 按证券独立 commit；单证券失败 rollback 续下一只（断点即数据本身）；变更集重算。
  **注意**：``rollback()`` 会 expire 会话内全部 ORM 实例，故循环外解析的补充源
  ``detail`` 在失败后必须重新解析（``_re_resolve_detail_after_rollback``），否则
  后续证券读取 ``detail.params`` 会触发同步惰性加载 → MissingGreenlet 连锁失败。
"""
from __future__ import annotations

import logging
import re
from datetime import date
from decimal import Decimal, InvalidOperation
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
# 注意：该接口**逐只查询**（代码由请求 params.symbol 传入），响应只有下列 4 个业务列
# （公告日期/送股/转增/派息/进度/除权除息日/股权登记日/红股上市日），**不含代码列**。
# 因此本模块解析新浪行一律走下列硬编码常量，**不读 itf.resp_code_field**——
# 该行配置（seed 遗留 'code'）与源站无对应列，纯属历史占位，勿据此取值。
_COL_SINA_ANN = "公告日期"
_COL_SINA_CASH = "派息"
_COL_SINA_PROGRESS = "进度"
_COL_SINA_EXDATE = "除权除息日"

# 特别分红历史回补窗口（§6.9）：与 §6.3 留存窗口一致，保留最近 5 个财年
_BACKFILL_YEARS = 5

logger = logging.getLogger(__name__)


def _anchor(ann: date) -> tuple[int, int]:
    """公告日期 → (report_year, report_quarter)：'SPECIAL 落格锚点'（§2.1 决策 A6）。

    年 = 公告年；季 = 公告月份所在日历季度（``ceil(月/3)``）。
    """
    return ann.year, (ann.month - 1) // 3 + 1


def _sina_cash(raw: Any) -> Optional[Decimal]:
    """新浪 '派息'（每 10 股派 X 元）→ 每股金额（÷10）。

    ``Decimal('NaN')`` 是合法构造（上游缺失金额可能返回 "NaN"/"nan" 等形态），
    须显式判 ``is_nan`` 归为 None，避免 NaN 落库污染快照。
    """
    if raw in (None, "", "-", "nan", "None"):
        return None
    try:
        d = Decimal(str(raw).strip())
        if d.is_nan():
            return None
        return d / Decimal("10")
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

    async def _provider_enabled(self, itf: QuoteInterface) -> bool:
        """提供方启用校验（ADR-002 #1 修复口径：所有选源路径须过滤提供方 enabled，
        否则停用提供方但其下接口仍 enabled 时会被照常选用）。"""
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        return provider is not None and provider.enabled

    async def _resolve_detail_itf(
        self, settings: Optional[DividendYieldSettings]
    ) -> Optional[QuoteInterface]:
        """解析补充源：存在性 + 分类 3 + 接口/提供方 enabled 校验；失败返回 None（记告警跳过）。"""
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
        """``rollback()`` 之后重新解析补充源（§6.8/§6.9「失败续下一只」的前置条件）。

        ``Session.rollback()`` 在有活动事务时会 expire 会话内**全部** ORM 实例
        （这与 ``expire_on_commit=False`` 无关，无活动事务时为空操作不触发 expire）。
        随之过期，下一只证券再读 ``detail.params`` / ``detail.name`` 会触发**同步**
        惰性加载 → ``MissingGreenlet: greenlet_spawn has not been called``；该异常被
        单证券 ``except Exception`` 吞掉计入失败 → 再次 ``rollback()`` → 其后**每一只**
        证券连锁失败，「失败续下一只」的容错形同虚设（全量 4609 只串行时几乎必然触发）。

        故失败路径必须重新解析补充源。仅在失败路径重解析（而非每只都解析），避免为
        4609 只引入同等数量的无谓查询。

        重解析为 ``None``（补充源在执行过程中被停用/删除/提供方停用）→ **fail fast
        raise**：否则「补充源失效」会被伪装成「每只都失败」，掩盖真实原因。

        Raises:
            RuntimeError: 补充源在本次执行过程中变为不可用。
        """
        fresh = await self._resolve_detail_itf(await self._settings())
        if fresh is None:
            raise RuntimeError(
                "补充源（新浪历史分红明细）在本次执行过程中变为不可用"
                "（接口被停用/删除、分类不符或提供方被停用），fail fast 终止："
                "剩余证券无法继续逐只补充"
            )
        return fresh

    async def _resolve_notice_itf(
        self, settings: Optional[DividendYieldSettings]
    ) -> QuoteInterface:
        """解析公告源（§5.4 可配置化）：优先读全局配置，未配置回退分类 4 priority 最小。

        - 配置了 ``announcement_source_interface_id``：校验（存在性 + 分类 4 + 接口/
          提供方 enabled），任一不符 → fail fast raise，**不静默回退**——把失效/非公告
          接口悄悄换成其他分类 4 接口会掩盖配置错误（§5.4 fail closed 口径）。
        - 未配置：回退分类 4 enabled 接口按 priority 升序首个（``_interfaces_for_category``
          已按 priority 排序并连表过滤提供方 enabled）；分类 4 无可用接口 → fail fast raise。
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
        """每日公告扫描 + 特别分红补充（§6.8 全流程）。"""
        day = today_app_tz()
        # 第一步：公告源 = 全局配置 announcement_source_interface_id（§5.4 可配置化），
        # 未配置回退分类 4 enabled 按 priority 升序首个；缺失/停用 → fail fast
        notice_itf = await self._resolve_notice_itf(await self._settings())

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
                # rollback() 会 expire 会话内实例 → detail 过期；须重新解析，否则下一只
                # 在 _process_master 中读 detail.params / detail.name 会触发同步惰性加载
                # → MissingGreenlet，把「源失效」伪装成「每只都失败」（详见
                # ``_re_resolve_detail_after_rollback``）。补充源本就缺失（detail is None）
                # 时无需重解析——此时 _process_master 不会触碰 detail。
                if detail is not None:
                    detail = await self._re_resolve_detail_after_rollback()

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

    # ------------------------------------------------------------------ #
    # 特别分红历史回补（§6.9，冷启动一次性手动 trigger）
    # ------------------------------------------------------------------ #
    async def backfill_specials(self, cfg: Any) -> str:
        """特别分红历史回补（§6.9）：遍历 security_dividends 已有 master，逐只回溯新浪历史明细。

        硬约束（依附录 A.12 / A.13 实测）：
        - **只处理「进度含实施 且 除权除息日非空」的行** → PAID。这是西向去重
          ``ex_dividend_date`` 分支可用的前提；一旦放宽到预案行（``ex_date`` 为空），
          普通分红会被误判为「东财缺失」而重复写入 SPECIAL，导致分子重复计数。
        - **5 年窗口过滤**：新浪返回该证券全历史（实测茅台 2002~2026 共 24 年）。
        - **必须在 §6.1 季度抓取之后执行**：西向去重依赖报告期行已存在。
        """
        today = today_app_tz()
        cutoff_year = today.year - _BACKFILL_YEARS + 1  # 窗口 [cur-4, cur]

        mids = set(
            (
                await self.session.execute(
                    select(SecurityDividend.master_id)
                    .where(SecurityDividend.period_type != ReportPeriodType.SPECIAL)
                    .distinct()
                )
            ).scalars().all()
        )
        if not mids:
            raise RuntimeError(
                "特别分红历史回补须在 §6.1 季度股息抓取之后执行：当前无报告期分红行；"
                "若继续，全部普通分红都会被判为「东财缺失」而落 SPECIAL（分子重复计数）"
            )
        detail = await self._resolve_detail_itf(await self._settings())
        if detail is None:
            raise RuntimeError("补充源（新浪历史分红明细）缺失或未启用，fail fast 跳过回补")
        code_map = await self._master_code_map(mids)
        # 进入逐只回补前先提交：① 释放前置只读查询占用的事务——后续是数千只证券的串行
        # HTTP 调用，长期持有事务（idle in transaction）会阻塞 vacuum 并放大锁竞争；
        # ② 使「单只失败 → rollback」只回滚该只自身的写入，而不把前置查询已加载的
        # 实例一并 expire（rollback 无活动事务时为空操作，不触发 expire）。
        # 依赖 ``expire_on_commit=False``（工程全局口径）：提交不会使 detail 过期。
        await self.session.commit()

        stats = {"new": 0, "dup": 0, "window": 0, "nocash": 0, "failed": 0}
        changed: set[str] = set()
        for idx, mid in enumerate(sorted(mids), 1):
            code = code_map.get(mid)
            if not code:
                stats["failed"] += 1
                continue
            try:
                if await self._backfill_one(mid, code, detail, today, cutoff_year, stats):
                    changed.add(mid)
                await self.session.commit()
            except Exception:  # 单证券失败：rollback 续下一只（§6.9 断点即数据本身）
                await self.session.rollback()
                stats["failed"] += 1
                # rollback() 会 expire 会话内实例 → detail 过期，下一只再读
                # detail.params 会触发同步惰性加载 → MissingGreenlet → 连锁全部计入失败。
                # 故失败后必须重新解析补充源（仅失败路径，避免每只一次无谓查询），
                # 源已失效则 fail fast raise（详见 ``_re_resolve_detail_after_rollback``）。
                detail = await self._re_resolve_detail_after_rollback()
            if idx % 200 == 0:
                logger.info(
                    "特别分红回补进度 %d/%d：新写%d 去重跳过%d 失败%d",
                    idx, len(mids), stats["new"], stats["dup"], stats["failed"],
                )

        await refresh_yields_for_masters(self.session, list(changed))
        await self.session.commit()
        return (
            f"特别分红历史回补完成：证券{len(mids)}只；SPECIAL 新写{stats['new']}；"
            f"去重跳过{stats['dup']}；窗口外{stats['window']}；无金额{stats['nocash']}；"
            f"失败{stats['failed']}只；重算{len(changed)}只"
        )

    async def _backfill_one(
        self,
        mid: str,
        code: str,
        detail: QuoteInterface,
        today: date,
        cutoff_year: int,
        stats: dict,
    ) -> bool:
        """单只证券回补：解析新浪历史明细逐行写 SPECIAL；返回是否有变更。"""
        digits = re.sub(r"\D", "", code)
        srows = await self._mds._call_interface_raw(
            detail, {**(detail.params or {}), "symbol": digits}, None
        )
        dirty = False
        for r in srows:
            cash = _sina_cash(_row_get(r, _COL_SINA_CASH))
            if cash is None:
                stats["nocash"] += 1
                continue
            progress = str(_row_get(r, _COL_SINA_PROGRESS) or "")
            ex_date = parse_date(_row_get(r, _COL_SINA_EXDATE))
            # 只认「实施」行：ex_date 非空是西向去重可用的前提（附录 A.12）
            if "实施" not in progress or ex_date is None:
                continue
            ann = parse_date(_row_get(r, _COL_SINA_ANN)) or today
            ry, rq = _anchor(ann)
            if ry < cutoff_year:  # 5 年窗口过滤（新浪返回全历史）
                stats["window"] += 1
                continue
            if await self._westward_dup(mid, ex_date, ry, rq, cash):
                stats["dup"] += 1
                continue
            if await self._exists_anchor(mid, ry, rq):
                continue
            self.session.add(
                self._new_special(
                    mid, ry, rq, cash, DividendStatus.PAID, ex_date, ann, detail.name
                )
            )
            stats["new"] += 1
            dirty = True
        return dirty


async def run_dividend_notice_scan(cfg: Any) -> str:
    """模块级 handler：每日公告扫描 + 特别分红补充（§6.8 第 5 条系统任务）。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendNoticeScanService(session).scan(cfg)
        await session.commit()
    return result


async def run_dividend_special_backfill(cfg: Any) -> str:
    """模块级 handler：特别分红历史回补（§6.9，冷启动一次性手动 trigger）。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendNoticeScanService(session).backfill_specials(cfg)
        await session.commit()
    return result
