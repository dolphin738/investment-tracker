"""待人工划分分红 staging 服务（批次 B，§3.7）。

本模块本轮只承载 **staging 写入**（``stage_pending``）：把「现金 >0 但报告时间不可解析」
的巨潮行幂等落 ``security_dividend_pending``。人工划分服务（list/summary/assign/ignore/
reopen）与主表原子 upsert 属**批次 C**，届时追加，此处不预置空壳。

**不计入派生快照重算**：``stage_pending`` 返回 ``True`` 仅表示「新落一行待划分」，调用方
（scan / seed）**不得**据此把 ``master_id`` 加入派生快照重算集——staging 不改变主表
``security_dividends``，故不影响股息率。度量经 ``stats["staged"]``（队列写入数）暴露。
"""
from __future__ import annotations

import uuid

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.dividend_yield import SecurityDividendPending
from app.models.enums import DividendPendingStatus
from app.services.dividend_cninfo_parse import PendingDividendRow, pending_fingerprint


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
