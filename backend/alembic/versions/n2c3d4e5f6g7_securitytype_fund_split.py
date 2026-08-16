"""SecurityType 枚举调整：FUND→ON_EXCHANGE_FUND（场内基金），新增 OFF_EXCHANGE_FUND（场外基金），ETF/LOF 合并入场内基金。

- ALTER TYPE RENAME VALUE 'FUND' TO 'ON_EXCHANGE_FUND'：既有 FUND 行随枚举值更名自动继承（无需数据迁移）。
- ALTER TYPE ADD VALUE 'OFF_EXCHANGE_FUND'。
- ETF/LOF 物理值 PG 不支持 DROP（见 j9e0f1a2b3c4），故仅从 Python 枚举 / UI / 用法中移除；
  升级前先把任何残留 ETF/LOF 行归并到 ON_EXCHANGE_FUND，避免 Python 枚举缺成员导致加载失败。
"""

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "n2c3d4e5f6g7"
down_revision: str | None = "l1a2b3c4d5e6"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    ctx = op.get_context()
    with ctx.autocommit_block():
        # FUND 重命名为场内基金（保留数据）
        op.execute(
            text('ALTER TYPE "SecurityType" RENAME VALUE \'FUND\' TO \'ON_EXCHANGE_FUND\'')
        )
        # 新增场外基金
        op.execute(
            text("ALTER TYPE \"SecurityType\" ADD VALUE IF NOT EXISTS 'OFF_EXCHANGE_FUND'")
        )
    # 残留 ETF/LOF 行归并到场内基金（PG 不支持 DROP VALUE，物理值保留但不再使用）
    op.execute(
        text(
            "UPDATE securities SET asset_class='ON_EXCHANGE_FUND' "
            "WHERE asset_class IN ('ETF','LOF')"
        )
    )
    op.execute(
        text(
            "UPDATE portfolio_securities SET type='ON_EXCHANGE_FUND' "
            "WHERE type IN ('ETF','LOF')"
        )
    )
    op.execute(
        text(
            "UPDATE quote_provider_interfaces SET asset_class='ON_EXCHANGE_FUND' "
            "WHERE asset_class IN ('ETF','LOF')"
        )
    )


def downgrade() -> None:
    # 物理值 OFF_EXCHANGE_FUND 无法 DROP（PG 限制），仅逆转换数据并恢复 FUND 名。
    # 已合并的 ETF/LOF 行无法还原原始子类型（升级时信息已丢失），统一回退为场内基金。
    ctx = op.get_context()
    with ctx.autocommit_block():
        op.execute(
            text('ALTER TYPE "SecurityType" RENAME VALUE \'ON_EXCHANGE_FUND\' TO \'FUND\'')
        )
    op.execute(
        text(
            "UPDATE securities SET asset_class='FUND' "
            "WHERE asset_class='ON_EXCHANGE_FUND'"
        )
    )
    op.execute(
        text(
            "UPDATE portfolio_securities SET type='FUND' "
            "WHERE type='ON_EXCHANGE_FUND'"
        )
    )
    op.execute(
        text(
            "UPDATE quote_provider_interfaces SET asset_class='FUND' "
            "WHERE asset_class='ON_EXCHANGE_FUND'"
        )
    )
