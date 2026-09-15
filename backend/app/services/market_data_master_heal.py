"""证券主数据「自愈」mixin：重复行合并 + 派生 id 重算 + 丢弃类别清理。

自 ``market_data_sync`` 按位置拆分而来（ADR-002 / 架构治理 §4）：承载
``_normalize_and_dedupe_masters`` 与 ``_reassign_master_id`` —— 把历史上因不同源
「带/不带交易所字母」产生的重复主数据行收敛到新自然键 ``(asset_class, code)``。

依赖方向：``market_data_params ← 本模块``；本模块不得 import 门面（循环导入）。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy import exists as sa_exists
from sqlalchemy import select, update
from sqlalchemy.orm import aliased

from app.models.enums import SecurityType
from app.models.security import PortfolioSecurity, Security
from app.services.classification import (
    EXCHANGE_PREFIX,
    classify_security,
    infer_exchange,
    is_dropped,
)
from app.services.market_data_params import _normalize_master_code, master_id_for
from app.services.security import infer_security_type


class SecurityMasterHealMixin:
    """证券主数据自愈（重推断 + 去重合并 + id 重派生）。"""

    async def _normalize_and_dedupe_masters(self) -> int:
        """扫描系统主数据并自愈：

        1) 逐行从**数字码**重推交易所 / 资产类别 / 规范码（``infer_security_type`` +
           ``_infer_exchange``），忽略已存错的 ``exchange``（避免错标被继承），修正历史错位：
           - 北京主板 ``920xxx`` 曾被误判 SH → 归 BJ
           - 港股 5 位码（``80016``/``02318``…）曾被 head 规则误归 BJ/SZ → 归 HK
           - 可转债 ``11xxxx``/``12xxxx``、深市基金 ``15/16xxxx`` 曾漏交易所前缀
             （``_infer_exchange`` 无对应分支返回 None）→ 补 SH/SZ 前缀
        2) 按 ``(asset_class, 规范code)`` 合并重复行（不同源带/不带交易所字母导致的历史重复）。
        3) 对保留行按新自然键 ``(asset_class, code)`` 重算派生 id 并迁移
           ``portfolio_securities`` 引用（见 ``_reassign_master_id``），消除「code 已自愈、
           id 仍是旧键派生」的历史错位——否则下次同步按新 code 查重未命中、按新 id
           INSERT 会撞上旧 id 记录，触发 ``securities_pkey`` 唯一约束冲突。

        顺序：先在内存完成「重推断 + 分组」，再删除重复行，最后统一 ``flush``——
        避免两行在重推断后短暂撞 ``(asset_class, code)`` 唯一约束。

        合并规则：按 ``(asset_class, 规范code)`` 分组，保留 ``updated_at`` 最新行，其余删除；
        删除前把其 ``portfolio_securities`` 引用安全转移到保留行（保留行已在该组合持有同一标的
        → 属重复持仓，直接丢弃该残留引用），避免误删用户持仓。
        （securities 现为纯目录表，无 portfolio_id 列，故直接全表扫描。）
        """
        rows = (
            await self.session.execute(select(Security))
        ).scalars().all()

        # 0) 丢弃类别（按 fund-classification-rules.md）：老三板/全国股转(4xxxxx)、
        #    北交所旧段(8xxxxx) 不写入 securities 主数据表，自愈时直接物理删除，
        #    确保这些类别在表中物理不存在（含名称含「退债」的退市可转债，落 4xxxxx
        #    段一律丢弃，不作例外）。
        dropped_securities: list[Security] = []
        normal_rows: list[Security] = []
        for s in rows:
            digits = re.sub(r"\D", "", s.code or "")
            if digits and is_dropped(digits, s.name or ""):
                dropped_securities.append(s)
            else:
                normal_rows.append(s)

        # 1) 逐行从数字码重推「交易所 / 资产类别 / 规范码」目标值（忽略已存错的 exchange，
        #    以免错标被继承）。仅计算、暂不改写，避免两行重推断后短暂撞唯一约束。
        targets: dict[Security, tuple[str, Optional[str], Any]] = {}
        for s in normal_rows:
            digits = re.sub(r"\D", "", s.code or "")
            if not digits:
                continue
            ex = infer_exchange(digits)
            code = _normalize_master_code(digits, ex)
            # 传名称：混合段场内基金需靠 ETF/LOF/REIT/封闭 等名称标记判定场内
            ac = infer_security_type(code, ex, s.name or "")
            # 指数前缀修正：000xxx 上证指数强制 sh、399xxx 深证指数强制 sz，
            # 自愈历史误存（如 sz000012 国债指数）为 sh000012
            if ac == SecurityType.INDEX:
                ex = classify_security(code, s.name or "").get("exchange") or ex
                code = f"{EXCHANGE_PREFIX.get(ex or '', '')}{digits}"
            targets[s] = (code, ex, ac)

        # 2) 按目标 (asset_class, 规范code) 分组
        groups: dict[tuple, list[Security]] = {}
        for s, t in targets.items():
            groups.setdefault(t, []).append(s)

        # 整个方法在 no_autoflush 下进行：重推断的待定改动不会在删除 dup 前被提前 flush 触发
        removed = 0
        ps_alias = aliased(PortfolioSecurity)
        with self.session.no_autoflush:
            for (code, ex, ac), items in groups.items():
                if len(items) == 1:
                    s = items[0]
                    if (s.code, s.exchange, s.asset_class) != (code, ex, ac):
                        s.code, s.exchange, s.asset_class = code, ex, ac
                    # id 与自然键一致时 _reassign_master_id 纯 CPU 早退（无 SQL）；
                    # 错位脏数据仍走 reassign 自愈，语义与逐行版本一致。
                    # 仅省去无变化行的无条件 flush（万行级时 dirty 扫描可观）。
                    await self._reassign_master_id(s)
                    continue
                items.sort(key=lambda x: (x.updated_at or datetime.min), reverse=True)
                keep = items[0]
                # 先安全转移并删除重复行；此时 keep 仍保留旧 code，无撞键风险
                for dup in items[1:]:
                    # 转移组合持仓引用到 keep：仅当 keep 尚未在该组合持有该标的时
                    await self.session.execute(
                        update(PortfolioSecurity)
                        .where(
                            PortfolioSecurity.master_id == dup.id,
                            ~sa_exists().where(
                                ps_alias.portfolio_id == PortfolioSecurity.portfolio_id,
                                ps_alias.master_id == keep.id,
                            ),
                        )
                        .values(master_id=keep.id)
                    )
                    # 清除无法转移（keep 已持有 → 属重复持仓）的残留引用
                    await self.session.execute(
                        sa_delete(PortfolioSecurity).where(
                            PortfolioSecurity.master_id == dup.id
                        )
                    )
                    await self.session.delete(dup)
                await self.session.flush()  # 先落库删掉 dup
                # 再对保留行应用重推断结果（此时 dup 已删，无撞键风险）
                keep.code, keep.exchange, keep.asset_class = code, ex, ac
                await self._reassign_master_id(keep)
                await self.session.flush()
                removed += len(items) - 1

        # 3) 物理删除丢弃类别行：先清除其 portfolio_securities 引用，避免悬空外键，
        #    再删除主数据行，确保老三板/全国股转(4xxxxx)、北交所旧段(8xxxxx) 不在表中。
        if dropped_securities:
            for s in dropped_securities:
                await self.session.execute(
                    sa_delete(PortfolioSecurity).where(
                        PortfolioSecurity.master_id == s.id
                    )
                )
                await self.session.delete(s)
                removed += 1
            await self.session.flush()

        return removed

    async def _reassign_master_id(self, s: Security) -> None:
        """重算并迁移 ``securities.id``：当自愈把某行的 code/asset_class 重推后，
        旧派生 id 不再等于 ``master_id_for(asset_class, code)`` 时，按新自然键重派生 id，
        并同步迁移 ``portfolio_securities.master_id`` 外键引用，保证 id 与
        ``(asset_class, code)`` 永远一致（否则下次同步按新 code 查重未命中、按新 id
        INSERT 会撞上旧 id 记录，触发 ``securities_pkey`` 唯一约束冲突）。

        依赖 ``master_id_for`` 的确定性：同一 ``(asset_class, code)`` 恒得同一 UUID，
        不同自然键的 id 必不相同，故新 id 正常情况下不会被其他行占用（撞键时跳过，
        由后续合并去重兜底）。
        """
        new_id = master_id_for(s.asset_class, s.code)
        if new_id == s.id:
            return
        clash = (
            await self.session.execute(
                select(Security.id).where(
                    Security.id == new_id,
                    Security.id != s.id,
                )
            )
        ).scalar_one_or_none()
        if clash:
            return
        # master_id 外键为 DEFERRABLE INITIALLY DEFERRED：先迁移持仓引用、再改 securities.id，
        # FK 检查推迟到事务提交，彼时两行已一致，不会因「改主键时子表仍引用旧 id」而报违例。
        # 注：本方法在 no_autoflush 上下文内调用，flush 不提前触发约束检查。
        await self.session.execute(
            update(PortfolioSecurity)
            .where(PortfolioSecurity.master_id == s.id)
            .values(master_id=new_id)
        )
        await self.session.execute(
            update(Security).where(Security.id == s.id).values(id=new_id)
        )
        s.id = new_id  # 保持 ORM 对象状态与库一致
        await self.session.flush()
