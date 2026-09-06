"""股息率排名：索引对齐 §8.1 排序契约（P2-1）+ 配置默认源按调用形态重选（P2-7）。

- 重建 ``security_dividend_yields`` 两个索引，使其与实际查询排序一致：
  - ``ix_dividend_yields_rank``：(dividend_yield DESC NULLS LAST, master_id ASC)（§8.1 强制式）；
  - ``ix_dividend_yields_consecutive``：(consecutive_years DESC NULLS LAST,
    dividend_yield DESC NULLS LAST, master_id ASC)（§8.3 榜二三元组）。
  0004 建为默认 ASC，与带 ``DESC NULLS LAST`` 的查询不匹配。
- 重刷 ``dividend_yield_settings`` 默认源（幂等，仅当当前值为空或**调用形态不符**时覆盖，
  不动 admin 显式配置的合法值）：主源 = 分类 3 + enabled + params 无 ``symbol``（按报告期
  全量形态）+ priority 最小；补充源 = 分类 3 + enabled + params 含 ``symbol``（逐只形态）
  + priority 最小（§5.4 四重校验同款形态判定）。0004 用接口 name 点名定位，属形态判定
  缺失期的临时实现，本迁移以形态规则收敛。
- downgrade：仅回退索引为 0004 的 ASC 形态；默认源收敛值**不回退**（幂等重刷无破坏性，
  回退反而会把形态不符的默认值带回来）。

Revision ID: 0005_dividend_index_defaults
Revises: 0004_dividend_yield
Create Date: 2026-09-06
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0005_dividend_index_defaults"
down_revision: str | None = "0004_dividend_yield"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# op.execute() 只接受单条 SQL（项目既有约束），全部分条执行。


def _rebuild_rank_indexes() -> None:
    """重建两个排名索引为 DESC NULLS LAST 形态（P2-1）。"""
    op.execute(
        text("DROP INDEX IF EXISTS ix_dividend_yields_rank")
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_dividend_yields_rank "
            "ON security_dividend_yields "
            "(dividend_yield DESC NULLS LAST, master_id ASC)"
        )
    )
    op.execute(
        text("DROP INDEX IF EXISTS ix_dividend_yields_consecutive")
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_dividend_yields_consecutive "
            "ON security_dividend_yields "
            "(consecutive_years DESC NULLS LAST, dividend_yield DESC NULLS LAST, master_id ASC)"
        )
    )


def _restore_rank_indexes() -> None:
    """回退为 0004 的 ASC 形态（与 0004 downgrade 后的模型一致）。"""
    op.execute(text("DROP INDEX IF EXISTS ix_dividend_yields_rank"))
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_dividend_yields_rank "
            "ON security_dividend_yields (dividend_yield, master_id)"
        )
    )
    op.execute(text("DROP INDEX IF EXISTS ix_dividend_yields_consecutive"))
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_dividend_yields_consecutive "
            "ON security_dividend_yields (consecutive_years)"
        )
    )


def _reseed_default_sources() -> None:
    """默认源按「调用形态 + priority」重选（P2-7）。

    仅覆盖**当前值为空或形态不符**的槽位：形态不符 = 指向的接口 params 与槽位要求相反
    （如主源指向逐只接口会让 §6.1 按报告期抓取静默失效）。params 列为 json，
    统一转 ::jsonb 使用 ``?`` 操作符判定 symbol 键。
    """
    # 主源：分类 3 + enabled + 按报告期全量形态（params 无 symbol）+ priority 最小
    op.execute(
        text(
            """
            UPDATE dividend_yield_settings s
            SET dividend_report_source_interface_id = best.id
            FROM (
                SELECT i.id FROM quote_provider_interfaces i
                WHERE i.category_id = '3' AND i.enabled
                  AND COALESCE(i.params::jsonb ? 'symbol', false) = false
                ORDER BY i.priority NULLS LAST, i.created_at
                LIMIT 1
            ) best
            WHERE (
                s.dividend_report_source_interface_id IS NULL
                OR EXISTS (
                    SELECT 1 FROM quote_provider_interfaces cur
                    WHERE cur.id = s.dividend_report_source_interface_id
                      AND COALESCE(cur.params::jsonb ? 'symbol', false)
                )
            )
            """
        )
    )
    # 补充源：分类 3 + enabled + 逐只形态（params 含 symbol）+ priority 最小
    op.execute(
        text(
            """
            UPDATE dividend_yield_settings s
            SET dividend_detail_source_interface_id = best.id
            FROM (
                SELECT i.id FROM quote_provider_interfaces i
                WHERE i.category_id = '3' AND i.enabled
                  AND COALESCE(i.params::jsonb ? 'symbol', false)
                ORDER BY i.priority NULLS LAST, i.created_at
                LIMIT 1
            ) best
            WHERE (
                s.dividend_detail_source_interface_id IS NULL
                OR EXISTS (
                    SELECT 1 FROM quote_provider_interfaces cur
                    WHERE cur.id = s.dividend_detail_source_interface_id
                      AND NOT COALESCE(cur.params::jsonb ? 'symbol', false)
                )
            )
            """
        )
    )


def upgrade() -> None:
    _rebuild_rank_indexes()
    _reseed_default_sources()


def downgrade() -> None:
    _restore_rank_indexes()
    # 默认源收敛值不回退：幂等重刷无破坏性，回退会把形态不符的默认值带回来
