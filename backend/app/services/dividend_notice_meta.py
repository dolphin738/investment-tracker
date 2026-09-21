"""公告扫描的「标题二筛」与「源解析 + 重解析韧性」（方案 §5.2/§5.4/§5.5）。

从 ``dividend_notice_scan.py`` 拆出（§6.3）：该文件达 566 行，超过项目约定单文件 ≤400 行
的人工上限。本模块承接两组**与落库无关**的职责，以 mixin（``NoticeMetaMixin``）形式提供，
供 ``DividendNoticeScanService`` 继承——方法内仍以 ``self.session`` / ``self._mds`` 访问宿主
实例的会话与分派器，故拆分对调用方**零感知**：私有方法经继承后仍可 ``self._x`` /
``scan_service._x`` 访问（``dividend_seed`` 亦无须改动调用点）。

**纯搬家不改变行为**（§6.3 硬要求）。归属约定：
- 本模块只放「选源 / 二筛 / 重解析」，**不含**落库与 upsert。
- ``_STATS_KEYS`` / ``_bump`` / ``_FAILURE_RATIO_RAISE`` 仍留在 ``dividend_notice_scan.py``
  ——两入口键集相等由测试守护，且落库计数与主流程同文件，不拆散。
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

from sqlalchemy import select

from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
)
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    NOTICE_CAT_ID,
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


class NoticeMetaMixin:
    """公告标题二筛 + 公告源/明细源解析 + 失败后重解析（混入 ``DividendNoticeScanService``）。

    依赖宿主实例提供：
    - ``self.session``：异步会话（查询设置 / 接口 / 证券）。
    - ``self._mds``：``MarketDataSyncService``（分类接口分派、required 行过滤、限流调用）。
    """

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
