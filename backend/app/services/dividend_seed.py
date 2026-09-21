"""首跑播种服务：全市场历史分红补齐（方案 §5.7）。

背景（§5.7 事实前提）：``DividendNoticeScanService.scan()`` 只拉**当天**公告
（``date = today_app_tz()``），本质是每日增量扫描器、不回溯历史，故「首跑把近 5 年
分过红的证券灌进来」必须是一条与 scan 窗口解耦的独立路径，即本模块承担的播种。

播种集合（§9.3-A4）：只实现 **B 全市场**——``securities`` 全表约 11430 只。

**为什么独立成模块**：``dividend_notice_scan.py`` 已 575 行，超过项目约定单文件
≤400 行的人工上限；本模块只放播种编排（种子集 + 断点续跑 + 逐只容错），不含解析。

**与 DividendNoticeScanService 的关系是「组合」而非「继承」**：本类持有自己的
session，内部实例化一个 scan service 作为采集能力提供方，复用它的两个既有能力——
- ``fetch_and_upsert_master``（单只入口，内部已做纯数字 symbol → 调巨潮 → 遍历
  全行 → ``parse_cninfo_row_ex`` → 真 5 年裁剪 ``retention_cutoff_year`` → upsert）；
  播种**不得**另写一套解析。
- ``_reresolve_detail_safe``（``rollback()`` 后重解析明细源，防 MissingGreenlet
  连锁失败）。
拼接它的实例而非继承，是因为播种不改写 scan 的任何行为，只需要这两项能力。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import Security, SecurityDividend
from app.services.dividend_cninfo_parse import retention_cutoff_year
from app.services.dividend_notice_scan import DividendNoticeScanService, _bump
from app.services.dividend_yield_refresh import refresh_yields_for_masters

# 与 scan._STATS_KEYS 必须完全一致（tests 有「两入口 stats 键集相等」守护）。
# 此处**独立定义**（非 import 共享）正是为了让「单侧加键导致摘要缺桶」被该用例捕获。
_STATS_KEYS: frozenset = frozenset({
    "rows", "hits", "new", "upd", "anchor", "skip",
    "no_period", "unknown_label", "collision", "window", "skipped",
})

# 分批粒度：同时用作「每 200 只打一条进度日志」的间隔与断点检查点的 IN 批大小（§5.7）
_SEED_CHUNK = 200

logger = logging.getLogger(__name__)


class DividendSeedService:
    """全市场历史分红首跑播种（§5.7；手动一次性、可断点续跑）。

    统计字典沿用 ``scan():200-209`` 的键口径（``rows/hits/new/upd/anchor/skip/
    window/skipped``），因为同一份 stats 会直接传给 ``fetch_and_upsert_master``
    由其累加新写/更新等计数，键名必须一致才能跨两个入口对账。
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
        stats["rows"] = total  # seed set 规模（≈11430 只）
        # 明细源缺失/停用沿用 scan():232 口径：不 fail fast，跳过逐只采集并在摘要里标注
        detail = await self._scan._resolve_detail_itf(await self._scan._settings())
        covered_skipped = 0  # 断点续跑：已覆盖而跳过的只数
        changed: set[str] = set()

        for start in range(0, total, _SEED_CHUNK):
            chunk = seed_rows[start : start + _SEED_CHUNK]
            # 检查点按批判定：避免一次性把「近 5 年全表 DISCTINCT master_id」拉进内存，
            # 批内 IN 列表只有 _SEED_CHUNK 个 UUID，走索引、结果集极小。
            covered = (
                await self._covered_masters(detail.name, [mid for mid, _ in chunk])
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
                        mid, code, detail, stats
                    ):
                        dirty = True
                    await self.session.commit()
                    stats["hits"] += 1
                    if dirty:
                        changed.add(mid)  # 仅提交成功后计入变更集
                except Exception:  # 单只失败：rollback 续下一只（断点即数据本身，§5.7）
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
        return (
            f"历史分红播种完成{note}：证券总数{stats['rows']}只，"
            f"已覆盖跳过{covered_skipped}只，本轮处理{stats['hits']}只，"
            f"失败{stats['skipped']}只；"
            f"分红行新写{stats['new']}/更新{stats['upd']}；"
            f"窗口外{stats['window']}/无派息{stats['skip']}/无报告期{stats['no_period']}；"
            f"标签撞键{stats['collision']}/未知标签{stats['unknown_label']}；"
            f"去重跳过{stats['anchor']}；重算{len(changed)}只"
        )

    async def _seed_rows(self) -> list[tuple[str, str]]:
        """seed set：全市场证券 ``(id, code)``，按 id 排序保证重跑顺序稳定。

        为什么一次性取出而非流式游标：① 播种期间会话要为每只证券穿插写库与 commit，
        ``session.stream()`` 的服务端游标不允许在其未消费完之前执行其它语句；
        ② seed set 仅约 11430 行两列短字符串，内存开销可忽略；
        ③ 取 ``Row`` 元组而非 ORM 实体，故不会被后续 ``rollback()`` expire。
        """
        rows = (
            await self.session.execute(select(Security.id, Security.code).order_by(Security.id))
        ).all()
        return [(str(row[0]), str(row[1])) for row in rows]

    async def _covered_masters(self, source: str, mids: list[str]) -> set[str]:
        """断点续跑检查点：本批 mids 中「已由当前明细源写入近 5 年记录」的 master_id。

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
        cutoff_year = retention_cutoff_year(today_app_tz())  # 真 5 年：[cur-4, cur]
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
