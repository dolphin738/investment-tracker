"""首跑播种服务：全市场历史分红补齐（方案 §5.7）。

背景（§5.7 事实前提）：``DividendNoticeScanService.scan()`` 只拉**当天**公告
（``date = today_app_tz()``），本质是每日增量扫描器、不回溯历史，故「首跑把近 5 年
分过红的证券灌进来」必须是一条与 scan 窗口解耦的独立路径，即本模块承担的播种。

播种集合（§9.3-A4 + 2026-09-22 收窄）：明细源（巨潮 ``stock_dividend_cninfo``）仅覆盖
沪深京 A股 + 北交所（``asset_class == STOCK``，含 B股），港股/指数/基金/债券等
**无**巨潮分红数据。故 seed set 收窄为 ``securities`` 中 ``asset_class == STOCK`` 的
serviceable 子集（约 5923 只），而非 ``securities`` 全表（约 11430 只）——既使失败率
分母落在「巨潮真能服务」的证券上（阈值才有意义），又避免对 5507 只无效证券空耗
``rate_limit=10/min`` 预算（耗时由约 19h 降至约 10h）。

**为什么独立成模块**：播种是与每日 scan 解耦的独立编排路径（种子集 + 断点续跑 + 逐只
容错），与 scan 的当日窗口逻辑无交集，故单独成模块、自持 session，只**组合** scan service
复用其单只采集能力（不继承、不复制解析）。

**与 DividendNoticeScanService 的关系是「组合」而非「继承」**：本类持有自己的
session，内部实例化一个 scan service 作为采集能力提供方，复用它的两个既有能力——
- ``fetch_and_upsert_master``（单只入口，内部已做纯数字 symbol → 调巨潮 → 遍历
  全行 → ``parse_cninfo_row_ex`` → 近 N 年裁剪 ``retention_cutoff_year``（years 取配置，
  默认 5）→ upsert）；播种**不得**另写一套解析。
- ``_reresolve_detail_safe``（``rollback()`` 后重解析明细源，防 MissingGreenlet
  连锁失败）。
拼接它的实例而非继承，是因为播种不改写 scan 的任何行为，只需要这两项能力。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import Security, SecurityDividend, SecurityType
from app.models.dividend_yield import DEFAULT_DIVIDEND_RETENTION_YEARS
from app.services.dividend_cninfo_parse import retention_cutoff_year
from app.services.dividend_notice_scan import DividendNoticeScanService, _bump
from app.services.dividend_yield_refresh import refresh_yields_for_masters

# 与 scan._STATS_KEYS 必须完全一致（tests 有「两入口 stats 键集相等」守护）。
# 此处**独立定义**（非 import 共享）正是为了让「单侧加键导致摘要缺桶」被该用例捕获。
_STATS_KEYS: frozenset = frozenset({
    "rows", "hits", "new", "upd", "anchor", "skip",
    "no_period", "unknown_label", "collision", "window", "skipped", "staged",
})

# 分批粒度：同时用作「每 200 只打一条进度日志」的间隔与断点检查点的 IN 批大小（§5.7）
_SEED_CHUNK = 200

# 失败占比阈值（行动项 8，设计 §6.2；owner 2026-09-22 最终裁定：**比例 10%**）。
# 逐只容错是「单只异常 → rollback 续下一只」；但整轮失败率超过该阈值即判定为「上游整体
# 失效」，必须冒泡（RuntimeError）让 scheduler 记 FAILED，而非把上万只吞成 skipped、摘要
# 仍报「完成」。分母 = seed set 规模（serviceable STOCK 子集，约 5923 只，非全表 11430）；
# 取 10%（≈592 只）：健康运行时个别失败（退市/停牌数据异常）应远低于此，而巨潮一旦出现
# 整体性降级即可早停止损——相较早前的 50%（≈2962 只才中止）大幅提前，与 scan 同口径。
# 注：曾短暂改为绝对只数口径，owner 最终选择比例（与 scan 同口径），绝对数代码已删除。
_FAILURE_RATIO_RAISE = 0.1

logger = logging.getLogger(__name__)


# ── 进度可视化（管理端「补齐历史分红」按钮轮询；进程内内存态） ──
# 仅用于前端实时展示「已处理 / 失败 / 已覆盖跳过」等运行进度；不入库、不跨进程。
# 进程重启或后台任务被强制杀死会残留 stale 态（running），前端可据 finished_at 判断。
def _seed_progress_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class SeedProgress:
    """首跑播种运行进度（fire-and-forget 后台任务，单进程内存态）。

    state: idle（本进程生命周期内从未跑 / 已复位）| running | done | error |
    cancelled（用户主动取消，已完成部分保留、可再次触发续跑）。
    failed = 单只异常 rollback 续跑的只数（≡ stats["skipped"]），与「无派息」
    （stats["skip"]）、「窗口外」（stats["window"]）严格区分，避免把正常零分红
    证券误报为失败。
    """

    state: str = "idle"
    total: int = 0
    processed: int = 0
    hits: int = 0          # 本轮实际拉取并落库的证券只数
    failed: int = 0        # 单只异常 rollback 续跑的只数
    covered: int = 0       # 断点续跑判定「已完成」而跳过的只数
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    message: str | None = None


seed_progress = SeedProgress()


class DividendSeedService:
    """全市场历史分红首跑播种（§5.7；手动一次性、可断点续跑）。

    统计字典沿用 ``scan():200-209`` 的键口径（``rows/hits/new/upd/anchor/skip/
    no_period/unknown_label/collision/window/skipped/staged``），因为同一份 stats 会直接传给
    ``fetch_and_upsert_master`` 由其累加新写/更新等计数，键名必须一致才能跨两个入口对账。
    """

    def __init__(self, session) -> None:
        self.session = session
        # 组合关系（非继承）：借用 scan service 的单只采集与失败后重解析能力
        self._scan = DividendNoticeScanService(session)

    async def seed_initial_dividends(self, cfg: Any) -> str:
        """按 seed set 逐只补历史分红；返回可运维对账的摘要字符串。"""
        seed_rows = await self._seed_rows()
        total = len(seed_rows)
        stats: dict[str, int] = {k: 0 for k in _STATS_KEYS}
        stats["rows"] = total  # seed set 规模（serviceable STOCK 子集，约 5923 只）
        # 明细源缺失/停用沿用 scan():232 口径：不 fail fast，跳过逐只采集并在摘要里标注
        settings = await self._scan._settings()
        detail = await self._scan._resolve_detail_itf(settings)
        # 留存窗年数：与 retention_cleanup 共用同一配置，保证「采集窗 == 清理窗」
        retention_years = (
            settings.dividend_retention_years
            if settings is not None and settings.dividend_retention_years is not None
            else DEFAULT_DIVIDEND_RETENTION_YEARS
        )
        covered_skipped = 0  # 断点续跑：已覆盖而跳过的只数
        changed: set[str] = set()

        # 进度可视化：进入 running 态（前端据此轮询；进程内内存态）
        seed_progress.state = "running"
        seed_progress.total = total
        seed_progress.processed = 0
        seed_progress.hits = 0
        seed_progress.failed = 0
        seed_progress.covered = 0
        seed_progress.started_at = _seed_progress_now()
        seed_progress.finished_at = None
        seed_progress.error = None
        seed_progress.message = None

        for start in range(0, total, _SEED_CHUNK):
            chunk = seed_rows[start : start + _SEED_CHUNK]
            # 检查点按批判定：避免一次性把「近 5 年全表 DISCTINCT master_id」拉进内存，
            # 批内 IN 列表只有 _SEED_CHUNK 个 UUID，走索引、结果集极小。
            covered = (
                await self._covered_masters(
                    detail.name, [mid for mid, _ in chunk], retention_years
                )
                if detail is not None
                else set()
            )
            for offset, (mid, code) in enumerate(chunk):
                idx = start + offset + 1
                if mid in covered:  # 已完成的历史证券不再重复消耗 rate_limit 预算
                    covered_skipped += 1
                    continue
                # snapshot：rollback 会丢弃该只已累加的计数，须回退——摘要须等于实际
                # 落库结果，否则运维按摘要对账会偏大（与 scan():243 同口径）。
                snapshot = dict(stats)
                try:
                    dirty = False
                    if detail is not None and await self._scan.fetch_and_upsert_master(
                        mid, code, detail, stats, retention_years
                    ):
                        dirty = True
                    await self.session.commit()
                    stats["hits"] += 1
                    if dirty:
                        changed.add(mid)  # 仅提交成功后计入变更集
                except Exception:  # 单只失败：rollback 续下一只（断点即数据本身，§5.7）
                    logger.warning(
                        "历史分红播种单只失败 master_id=%s（rollback 续下一只）",
                        mid, exc_info=True,
                    )
                    await self.session.rollback()
                    stats.update(snapshot)
                    _bump(stats, "skipped")
                    # rollback() 会 expire 会话内实例 → detail 过期；须重新解析，否则下一只
                    # 读 detail.params / detail.name 会触发同步惰性加载 → MissingGreenlet。
                    # 明细源本就缺失时无需重解析（scan():266 同口径）。
                    if detail is not None:
                        # 源已失效则 fail fast raise；过程异常记日志续下一只（L-3）
                        detail = await self._scan._reresolve_detail_safe(idx, total) or detail
            logger.info(
                "历史分红播种进度：已处理 %d/%d 只；本轮处理 %d 只，失败 %d 只，"
                "分红行新写 %d/更新 %d",
                min(start + _SEED_CHUNK, total), total,
                stats["hits"], stats["skipped"], stats["new"], stats["upd"],
            )
            # 进度可视化：每个检查点（每 _SEED_CHUNK 只）刷新一次运行进度
            seed_progress.processed = min(start + _SEED_CHUNK, total)
            seed_progress.hits = stats["hits"]
            seed_progress.failed = stats["skipped"]
            seed_progress.covered = covered_skipped

        # 失败占比过高 → 冒泡（行动项 8，§6.2；与 scan 同口径）：使 scheduler 记
        # FAILED。分母 = seed set 规模（serviceable STOCK 子集，约 5923 只）；
        # covered_skipped 是「已完成跳过」，不计失败。total==0（无证券）时不做除法、也不判失败。
        if total > 0 and stats["skipped"] / total > _FAILURE_RATIO_RAISE:
            # 进度可视化：失败率冒泡 → 置 error（与 _run_seed 的兜底异常捕获二选一生效）
            seed_progress.state = "error"
            seed_progress.error = (
                f"失败占比过高：{stats['skipped']}/{total} 只"
                f"（阈值 {_FAILURE_RATIO_RAISE:.0%}），疑似上游整体失效"
            )
            seed_progress.finished_at = _seed_progress_now()
            raise RuntimeError(
                f"历史分红播种失败占比过高：{stats['skipped']}/{total} 只失败"
                f"（阈值 {_FAILURE_RATIO_RAISE:.0%}），疑似上游整体失效，终止并标记 FAILED"
            )

        # 未收录标签聚合告警：整轮仅一条（样例取出现频次最高的 3 种），与 scan 同口径。
        # 总量读 stats["unknown_label"]（随 snapshot rollback，口径与摘要一致）；Counter
        # 只用于算样例与「去重种数」，避免失败 rollback 后 Counter 未回退导致总数虚高。
        if self._scan._unknown_label_counts:
            samples = [label for label, _ in self._scan._unknown_label_counts.most_common(3)]
            logger.warning(
                "巨潮「分红类型」未收录标签共 %d 行、去重 %d 种，样例=%r",
                stats["unknown_label"],
                len(self._scan._unknown_label_counts), samples[:3],
            )

        # 完成后：仅变更集重算（与 scan():271-272 同口径）
        await refresh_yields_for_masters(self.session, list(changed))
        await self.session.commit()
        note = "；明细源缺失跳过逐只采集" if detail is None else ""
        summary = (
            f"历史分红播种完成{note}：证券总数{stats['rows']}只，"
            f"已覆盖跳过{covered_skipped}只，本轮处理{stats['hits']}只，"
            f"失败{stats['skipped']}只；"
            f"分红行新写{stats['new']}/更新{stats['upd']}；"
            f"窗口外{stats['window']}/无派息{stats['skip']}/无报告期{stats['no_period']}"
            f"/待划分{stats['staged']}；"
            f"标签撞键{stats['collision']}/未知标签{stats['unknown_label']}；"
            f"去重跳过{stats['anchor']}；重算{len(changed)}只"
        )
        # 进度可视化：整轮成功 → 置 done 并落摘要
        seed_progress.state = "done"
        seed_progress.finished_at = _seed_progress_now()
        seed_progress.message = summary
        return summary

    async def _seed_rows(self) -> list[tuple[str, str]]:
        """seed set：巨潮可服务的证券 ``(id, code)``，按 id 排序保证重跑顺序稳定。

        仅取 ``asset_class == STOCK``（沪深京 A股 + 北交所，含 B股）——明细源巨潮
        只覆盖这部分；港股/指数/基金/债券无巨潮分红数据，纳入只会稀释失败率分母并
        空耗限流预算（2026-09-22 收窄；生产库 STOCK 约 5923 / 全表 11430）。

        为什么一次性取出而非流式游标：① 播种期间会话要为每只证券穿插写库与 commit，
        ``session.stream()`` 的服务端游标不允许在其未消费完之前执行其它语句；
        ② seed set 仅约 5923 行两列短字符串，内存开销可忽略；
        ③ 取 ``Row`` 元组而非 ORM 实体，故不会被后续 ``rollback()`` expire。
        """
        rows = (
            await self.session.execute(
                select(Security.id, Security.code)
                .where(Security.asset_class == SecurityType.STOCK)
                .order_by(Security.id)
            )
        ).all()
        return [(str(row[0]), str(row[1])) for row in rows]

    async def _covered_masters(
        self, source: str, mids: list[str], retention_years: int
    ) -> set[str]:
        """断点续跑检查点：本批 mids 中「已由当前明细源写入近 N 年记录」的 master_id。

        **为什么必须带 ``source = :source``（关键陷阱）**：P1 才会删除旧新浪存量行
        （``source='新浪-分红配股'``，方案 §6）。在 P1 执行前，大量未播种的证券在
        ``security_dividends`` 里存在的**只是旧源行**，其 ``report_year`` 同样可能落在
        ``[cur-4, cur]`` 窗口内。若检查点只按 ``report_year >= cutoff`` 过滤，会把这些
        尚未播种的证券误判为「已完成」而跳过 —— 播种形同虚效、静默无产出。

        限定 source 为**当前明细源**（``detail.name``）可精确刻画「本链路已经共产」：
        新链路写入/刷新的行 ``source`` 必为巨潮接口名（`_upsert_one` 每次写入都会把
        source 一并刷新为当前源），而旧新浪行的 source 永不等于该值。

        **P1 删存量之后是否仍成立**：成立且更精确。旧行删除后表内只剩本链路写入的行，
        source 过滤退化为恒真，不影响判据正确性；同时它仍能正确排除「窗口外（>5 年）
        的历史行」造成的误判。唯一副作用：若将来明细源接口被**改名**，旧行的 source
        不再等于新名，这批证券会被判定为未覆盖而重跑一遍——upsert 幂等，代价仅为一次
        约 19 小时的重跑，不追求该场景下的极致省时（正确性优先）。
        """
        cutoff_year = retention_cutoff_year(today_app_tz(), retention_years)  # 真 N 年：[cur-N+1, cur]
        rows = (
            await self.session.execute(
                select(SecurityDividend.master_id)
                .where(
                    SecurityDividend.master_id.in_(mids),
                    SecurityDividend.source == source,
                    SecurityDividend.report_year >= cutoff_year,
                )
                .distinct()
            )
        ).scalars().all()
        return set(rows)


async def run_dividend_seed(cfg: Any) -> str:
    """模块级 handler：首跑播种（§5.7）。

    会话建立写法与同仓库既有 handler 一致（``run_dividend_yield_rebuild`` 等同仓储
    handler）：handler 内部自建 ``AsyncSessionLocal``，使后台执行的播种与请求会话完全
    隔离；``AsyncSessionLocal`` 在函数内 import，避免装配期就把数据库引擎拉起（模块被
    router 侧导入时亦然）。播种路径已取代旧特别分红回补 handler（原
    ``run_dividend_special_backfill`` 在 P1 清理批次中已删除）。

    **不注册 JobType、不进 scheduler 的 ``_HANDLERS``、不开机自启**（§9.3-A7）：
    全市场约 19 小时且本质是一次性冷启动动作，进定时会每天重跑并打满
    ``rate_limit=10/min`` 预算，故唯一入口是管理端手动按钮（HTTP fire-and-forget）。
    """
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendSeedService(session).seed_initial_dividends(cfg)
        await session.commit()
    return result
