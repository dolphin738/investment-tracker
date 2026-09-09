"""NaN 数据清洗：删除分红表与快照表中 numeric NaN 行（2026-09-08 排查 600339 结论）

背景：上游（东财「分红配送」等）对缺失分红金额返回字符串 "NaN"，``Decimal("NaN")``
是合法构造，旧解析未拦导致 NaN 落库：

- ``security_dividends.cash_per_share = 'NaN'`` 359 行（PROPOSED 206 / PAID 153），
  NaN 参与快照分子求和后传播；
- ``security_dividend_yields.dividend_yield / numerator_per_share = 'NaN'`` 121 行
  （0 行 NULL）——进榜守卫 ``IS NOT NULL`` 对 NaN 失效，NaN 行混入榜单且在
  PG 排序中被视为最大值霸占榜首，前端 `formatPercent` 渲染为 "-"。

修复分层（方案 B）：
- 源头：``parse_cash`` / ``_sina_cash`` 显式 ``is_nan`` 归 None（代码先行，NaN 不再入库）；
- 守卫：rank / top20 / 连续榜进榜条件排除 NaN（代码先行，NaN 行即时从榜单消失）；
- 存量：本迁移删除两表 NaN 行（幂等，down 不可逆不还原）；删除后相关 master 的快照
  由 ``refresh_yields_for_masters`` 重算恢复（开发库经脚本执行；其他环境经
  「股息率全量重建」手动按钮或次日同步恢复）。

Revision ID: 0009_dividend_nan_cleanup
Revises: 0008_remove_dividend_yield_rebuild_task
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0010_dividend_nan_cleanup"
down_revision: Union[str, None] = "0009_fix_dividend_interface_code_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ① 先删快照 NaN 行（dividend_yield 或 numerator 任一为 NaN 即整行不可信）
    op.execute(
        "DELETE FROM security_dividend_yields "
        "WHERE dividend_yield = 'NaN' OR numerator_per_share = 'NaN'"
    )
    # ② 再删源头 NaN 分红记录（NaN 即「上游缺失金额」的脏数据，语义上不应存在）
    op.execute("DELETE FROM security_dividends WHERE cash_per_share = 'NaN'")


def downgrade() -> None:
    # 数据修复不可逆（NaN 脏数据不还原），down 为空
    pass
