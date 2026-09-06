"""股息率排名：数据层与种子（方案 §11.2 / §14.0）

- 新建 3 个原生枚举类型：DividendYieldMode / DividendStatus / ReportPeriodType。
- 扩展既有 ``JobTaskType`` 枚举 5 个值（股息抓取/日线/清理/重建/公告扫描）。
- 新建 5 张表：security_dividends / market_security_daily_prices /
  security_dividend_yields / dividend_yield_settings / market_trade_calendar。
- seed（幂等，全为 ``WHERE NOT EXISTS`` 保护）：
  - 新分类「公司公告」（id=4）；
  - providers（akshare / 腾讯财经）——仅当按 name 不存在时插入；
  - 4 条接口行（东财-分红配送、新浪-分红配股、沪深京 A 股公告、腾讯财经行情）；
  - 5 条系统任务（须在 JobTaskType ADD VALUE 提交后再 INSERT）；
  - 配置表默认行（阈值 0.05/0.03 + 分类内 priority 最小 enabled 接口作默认源）。

Revision ID: 0004_dividend_yield
Revises: 0003_interface_category_fk
Create Date: 2026-09-06
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0004_dividend_yield"
down_revision: str | None = "0003_interface_category_fk"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

DIVIDEND_LIST_CAT_ID = "3"
NOTICE_CAT_ID = "4"

_SETTINGS_ID = "00000000-0000-4000-9000-000000000001"

_MODE_VALUES = ["TTM", "LFY"]
_STATUS_VALUES = ["PROPOSED", "PAID", "REJECTED"]
_PERIOD_VALUES = ["ANNUAL", "INTERIM", "QUARTERLY", "SPECIAL"]

# 新增的 JobTaskType 枚举值（沿用既有 LOG_CLEANUP 扩展写法，autocommit 独立事务提交）
_NEW_JOB_TASK_TYPES = [
    "DIVIDEND_QUARTERLY_FETCH",
    "MARKET_DAILY_CLOSE_FETCH",
    "DIVIDEND_RETENTION_CLEANUP",
    "DIVIDEND_YIELD_REBUILD",
    "DIVIDEND_NOTICE_SCAN",
]

# 系统任务种子（name 唯一约束兜底幂等；cron 按 UTC+8 解释，§6）
_SYSTEM_TASKS = [
    {
        "name": "季度股息抓取",
        "task_type": "DIVIDEND_QUARTERLY_FETCH",
        "cron": "0 2 28-31 3,6,9,12 *",
        "enabled": True,
        "desc": "每季度最后一天按报告期抓取分红事件（东财主源，夜里 02:00；cron 只表达 28-31，真实季末日由任务内 guard 判定）",
    },
    {
        "name": "每日收盘价抓取",
        "task_type": "MARKET_DAILY_CLOSE_FETCH",
        "cron": "5 15 * * 1-5",
        "enabled": True,
        "desc": "每交易日收盘后（15:05）按代码分批抓取市场级日线收盘价并重除股息率",
    },
    {
        "name": "五年股息留存清理",
        "task_type": "DIVIDEND_RETENTION_CLEANUP",
        "cron": "0 3 1 1 *",
        "enabled": True,
        "desc": "每年 1 月 1 日按 report_year 清理 5 年前分红事件（含 PROPOSED/REJECTED），顺带刷新交易日历",
    },
    {
        "name": "股息率全量重建",
        "task_type": "DIVIDEND_YIELD_REBUILD",
        "cron": "0 4 * * *",
        "enabled": False,
        "desc": "全量重建派生快照（默认禁用，仅迁移后建基线或 admin 手动 trigger 时执行）",
    },
    {
        "name": "公告扫描与分红补充",
        "task_type": "DIVIDEND_NOTICE_SCAN",
        "cron": "0 6 * * *",
        "enabled": True,
        "desc": "每日按自然日扫描公司公告，检测特别分红并经新浪补充源写入 SPECIAL 行（含周末）",
    },
]


def _seed_providers() -> None:
    """幂等插入 providers（按 name 保护；开发库既有行不受影响）。"""
    op.execute(
        text(
            "INSERT INTO securities_data_providers "
            "(id, name, access_method, config, enabled, created_at, updated_at) "
            "SELECT gen_random_uuid(), 'akshare', 'sdk', '{\"sdk_name\": \"akshare\"}'::json, TRUE, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM securities_data_providers WHERE name = 'akshare')"
        )
    )
    op.execute(
        text(
            "INSERT INTO securities_data_providers "
            "(id, name, access_method, config, enabled, created_at, updated_at) "
            "SELECT gen_random_uuid(), '腾讯财经', 'https', '{\"base_url\": \"https://qt.gtimg.cn\"}'::json, TRUE, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM securities_data_providers WHERE name = '腾讯财经')"
        )
    )


def _seed_interfaces() -> None:
    """seed 4 条接口行（复用开发库真实配置；WHERE NOT EXISTS(name) 幂等）。"""
    # 东财-分红配送（分类 3，主源，按报告期全量；§6.1）
    # resp_code_field/name 填东财中文列名：_upsert_masters 按此取「代码」「名称」列（§6.1）。
    op.execute(
        text(
            "INSERT INTO quote_provider_interfaces "
            "(id, provider_id, category_id, name, endpoint, params, enabled, rate_limit, priority, "
            " resp_code_field, resp_name_field, resp_price_field, response_parse, created_at, updated_at) "
            "SELECT gen_random_uuid(), "
            "  (SELECT id FROM securities_data_providers WHERE name = 'akshare'), "
            "  :cat, '东财-分红配送', 'stock_fhps_em', "
            "  '{\"date\": \"20231231\"}'::json, TRUE, '10/min', 0, "
            "  '代码', '名称', 'price', '{\"format\": \"json\"}'::json, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM quote_provider_interfaces WHERE name = '东财-分红配送')"
        ).bindparams(cat=DIVIDEND_LIST_CAT_ID)
    )
    # 新浪-分红配股（分类 3，补充源，按证券逐只；§6.8）
    op.execute(
        text(
            "INSERT INTO quote_provider_interfaces "
            "(id, provider_id, category_id, name, endpoint, params, enabled, rate_limit, priority, "
            " resp_code_field, resp_price_field, response_parse, created_at, updated_at) "
            "SELECT gen_random_uuid(), "
            "  (SELECT id FROM securities_data_providers WHERE name = 'akshare'), "
            "  :cat, '新浪-分红配股', 'stock_history_dividend_detail', "
            "  '{\"symbol\": \"600012\", \"indicator\": \"分红\", \"date\": \"\"}'::json, TRUE, '10/min', 1, "
            "  'code', 'price', '{\"format\": \"json\"}'::json, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM quote_provider_interfaces WHERE name = '新浪-分红配股')"
        ).bindparams(cat=DIVIDEND_LIST_CAT_ID)
    )
    # 沪深京 A 股公告（分类 4，公告扫描；§6.8）
    op.execute(
        text(
            "INSERT INTO quote_provider_interfaces "
            "(id, provider_id, category_id, name, endpoint, params, enabled, priority, "
            " resp_code_field, resp_price_field, response_parse, created_at, updated_at) "
            "SELECT gen_random_uuid(), "
            "  (SELECT id FROM securities_data_providers WHERE name = 'akshare'), "
            "  :cat, '沪深京 A 股公告', 'stock_notice_report', "
            "  '{\"symbol\": \"财务报告\", \"date\": \"\"}'::json, TRUE, 0, "
            "  'code', 'price', '{\"format\": \"json\"}'::json, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM quote_provider_interfaces WHERE name = '沪深京 A 股公告')"
        ).bindparams(cat=NOTICE_CAT_ID)
    )
    # 腾讯财经-A股_场内基金_港股_行情（分类 2，行情价源，text_split；§6.2）
    # response_parse 附加 max_codes_per_request=800（腾讯 q= 实测上限，§6.2）与
    # resp_date_field="30"（腾讯行内「日期」字段下标，防线二·返回日期比对，决策 A9）。
    op.execute(
        text(
            "INSERT INTO quote_provider_interfaces "
            "(id, provider_id, category_id, name, endpoint, params, enabled, rate_limit, priority, "
            " resp_code_field, resp_price_field, response_parse, created_at, updated_at) "
            "SELECT gen_random_uuid(), "
            "  (SELECT id FROM securities_data_providers WHERE name = '腾讯财经'), "
            "  :cat, '腾讯财经-A股_场内基金_港股_行情', 'q=', "
            "  '{}'::json, TRUE, '10/min', 0, "
            "  '_code', '3', "
            "  '{\"format\": \"text_split\", \"encoding\": \"gbk\", \"sep\": \"~\", "
            "   \"line_regex\": \"v_(\\\\w+)=\\\"([^\\\"]*)\\\"\", "
            "   \"code_param\": \"q\", \"code_prefix\": \"auto\", "
            "   \"max_codes_per_request\": 800, \"resp_date_field\": \"30\"}'::json, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM quote_provider_interfaces "
            "                  WHERE name LIKE '腾讯财经-A股%行情')"
        ).bindparams(cat="2")
    )


def _seed_system_tasks() -> None:
    """seed 5 条系统任务（须在 JobTaskType ADD VALUE 提交后再执行）。"""
    for t in _SYSTEM_TASKS:
        op.execute(
            sa.text(
                """
                INSERT INTO job_configs
                    (id, name, task_type, kind, enabled, cron_expr, params, description, created_at, updated_at)
                SELECT
                    gen_random_uuid(), :name,
                    CAST(:task_type AS "JobTaskType"),
                    CAST('SYSTEM' AS "JobKind"),
                    :enabled, :cron, '{}'::json, :desc, now(), now()
                WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = :name)
                """
            ).bindparams(
                name=t["name"],
                task_type=t["task_type"],
                enabled=t["enabled"],
                cron=t["cron"],
                desc=t["desc"],
            )
        )


def _seed_settings() -> None:
    """seed 配置表默认行：阈值 0.05/0.03；默认源取分类内 priority 最小 enabled 接口。"""
    bind = op.get_bind()
    report_src = bind.execute(
        sa.text(
            "SELECT id FROM quote_provider_interfaces WHERE category_id = :cat "
            "AND enabled AND name = '东财-分红配送' ORDER BY priority NULLS LAST LIMIT 1"
        ).bindparams(**{"cat": DIVIDEND_LIST_CAT_ID})
    ).scalar()
    detail_src = bind.execute(
        sa.text(
            "SELECT id FROM quote_provider_interfaces WHERE category_id = :cat "
            "AND enabled AND name = '新浪-分红配股' ORDER BY priority NULLS LAST LIMIT 1"
        ).bindparams(**{"cat": DIVIDEND_LIST_CAT_ID})
    ).scalar()
    price_src = bind.execute(
        sa.text(
            "SELECT id FROM quote_provider_interfaces WHERE category_id = '2' "
            "AND enabled ORDER BY priority NULLS LAST LIMIT 1"
        )
    ).scalar()
    op.execute(
        sa.text(
            """
            INSERT INTO dividend_yield_settings
                (id, green_threshold, red_threshold,
                 dividend_report_source_interface_id, dividend_detail_source_interface_id,
                 price_source_interface_id, created_at, updated_at)
            VALUES
                (:id, 0.05, 0.03, :report_src, :detail_src, :price_src, now(), now())
            """
        ).bindparams(
            id=_SETTINGS_ID,
            report_src=report_src,
            detail_src=detail_src,
            price_src=price_src,
        )
    )


def upgrade() -> None:
    """建枚举（先于依赖列）→ 建 5 表 → 扩展 JobTaskType → 各类 seed。"""
    # 1) 新建 3 个原生枚举类型
    sa.Enum(*_MODE_VALUES, name="DividendYieldMode").create(op.get_bind(), checkfirst=True)
    sa.Enum(*_STATUS_VALUES, name="DividendStatus").create(op.get_bind(), checkfirst=True)
    sa.Enum(*_PERIOD_VALUES, name="ReportPeriodType").create(op.get_bind(), checkfirst=True)

    # 2) 建 5 张表
    op.create_table(
        "security_dividends",
        sa.Column("id", sa.String(36), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "master_id",
            sa.String(36),
            sa.ForeignKey("securities.id", ondelete="CASCADE", deferrable=True, initially="DEFERRED"),
            nullable=False,
        ),
        sa.Column("report_year", sa.Integer(), nullable=False),
        sa.Column("report_quarter", sa.SmallInteger(), nullable=False),
        sa.Column(
            "period_type",
            postgresql.ENUM(*_PERIOD_VALUES, name="ReportPeriodType", create_type=False),
            nullable=False,
        ),
        sa.Column("cash_per_share", sa.Numeric(18, 6), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(*_STATUS_VALUES, name="DividendStatus", create_type=False),
            nullable=False,
        ),
        sa.Column("ex_dividend_date", sa.Date(), nullable=True),
        sa.Column("announcement_date", sa.Date(), nullable=True),
        sa.Column("record_date", sa.Date(), nullable=True),
        sa.Column("source", sa.String(128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "master_id",
            "report_year",
            "report_quarter",
            "period_type",
            name="uq_security_dividends_master_period",
        ),
    )
    op.create_index("ix_security_dividends_master", "security_dividends", ["master_id"])
    op.create_index(
        "ix_security_dividends_report", "security_dividends", ["report_year", "report_quarter"]
    )

    op.create_table(
        "market_security_daily_prices",
        sa.Column("id", sa.String(36), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "master_id",
            sa.String(36),
            sa.ForeignKey("securities.id", ondelete="CASCADE", deferrable=True, initially="DEFERRED"),
            nullable=False,
        ),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("close", sa.Numeric(18, 6), nullable=False),
        sa.Column("source", sa.String(128), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "master_id", "trade_date", name="uq_market_daily_price_master_date"
        ),
    )
    op.create_index(
        "ix_market_daily_price_master_date",
        "market_security_daily_prices",
        ["master_id", "trade_date"],
    )

    op.create_table(
        "security_dividend_yields",
        sa.Column("id", sa.String(36), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "master_id",
            sa.String(36),
            sa.ForeignKey("securities.id", ondelete="CASCADE", deferrable=True, initially="DEFERRED"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "mode",
            postgresql.ENUM(*_MODE_VALUES, name="DividendYieldMode", create_type=False),
            nullable=False,
        ),
        sa.Column("numerator_per_share", sa.Numeric(18, 6), nullable=True),
        sa.Column("dividend_yield", sa.Numeric(18, 6), nullable=True),
        sa.Column("latest_price", sa.Numeric(18, 6), nullable=True),
        sa.Column("latest_trade_date", sa.Date(), nullable=True),
        sa.Column("consecutive_years", sa.SmallInteger(), nullable=True),
        sa.Column("last_dividend_year", sa.Integer(), nullable=True),
        sa.Column("ref_div_ids", postgresql.JSONB(), nullable=True),
        sa.Column("stale", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("suspicious", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_dividend_yields_rank", "security_dividend_yields", ["dividend_yield", "master_id"])
    op.create_index(
        "ix_dividend_yields_consecutive", "security_dividend_yields", ["consecutive_years"]
    )

    op.create_table(
        "dividend_yield_settings",
        sa.Column("id", sa.String(36), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("green_threshold", sa.Numeric(5, 4), nullable=False),
        sa.Column("red_threshold", sa.Numeric(5, 4), nullable=False),
        sa.Column(
            "dividend_report_source_interface_id",
            sa.String(36),
            sa.ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "dividend_detail_source_interface_id",
            sa.String(36),
            sa.ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "price_source_interface_id",
            sa.String(36),
            sa.ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "market_trade_calendar",
        sa.Column("trade_date", sa.Date(), primary_key=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # 3) 扩展 JobTaskType 枚举 5 值（autocommit 独立事务）
    ctx = op.get_context()
    with ctx.autocommit_block():
        for value in _NEW_JOB_TASK_TYPES:
            op.execute(
                text(f"ALTER TYPE \"JobTaskType\" ADD VALUE IF NOT EXISTS '{value}'")
            )

    # 4) 新分类「公司公告」（id=4）
    op.execute(
        text(
            "INSERT INTO quote_provider_interface_categories "
            "(id, label, icon, sort_order, system, created_at, updated_at) "
            "SELECT :id, '公司公告', 'ScrollText', 4, TRUE, now(), now() "
            "WHERE NOT EXISTS ("
            "  SELECT 1 FROM quote_provider_interface_categories "
            "  WHERE system AND label = '公司公告'"
            ")"
        ).bindparams(id=NOTICE_CAT_ID)
    )

    # 5) providers + 接口行（复用真实配置，幂等）
    _seed_providers()
    _seed_interfaces()

    # 6) 系统任务 seed（须在枚举 ADD 提交后）
    _seed_system_tasks()

    # 7) 配置默认行
    _seed_settings()


def downgrade() -> None:
    """回滚本迁移确定新建的对象；不做枚举值回收（PG 不支持 DROP VALUE）。

    兼容开发库：分类 2/3 下接口行、providers 可能是既有人工数据，downgrade 不删除；
    仅删除本迁移新建的分类 4 及其下接口行、5 条系统任务与配置默认行。
    """
    # 删除 5 条系统任务（先于 drop 表，二者无依赖，此处提前便于幂等）
    for t in _SYSTEM_TASKS:
        op.execute(sa.text("DELETE FROM job_configs WHERE name = :nm").bindparams(nm=t["name"]))
    # 删除挂在分类 4 下的接口行（本迁移 seed；dev 在 0004 前无分类 4，故必为本迁移所建）再删分类 4
    op.execute(
        sa.text("DELETE FROM quote_provider_interfaces WHERE category_id = :cat").bindparams(
            cat=NOTICE_CAT_ID
        )
    )
    op.execute(
        text("DELETE FROM quote_provider_interface_categories WHERE id = :id AND system").bindparams(
            id=NOTICE_CAT_ID
        )
    )
    # 删除配置默认行（须在 drop settings 表之前）
    op.execute(
        sa.text("DELETE FROM dividend_yield_settings WHERE id = :id").bindparams(id=_SETTINGS_ID)
    )

    op.drop_table("market_trade_calendar")
    op.drop_table("dividend_yield_settings")
    op.drop_table("security_dividend_yields")
    op.drop_table("market_security_daily_prices")
    op.drop_table("security_dividends")

    sa.Enum(*_MODE_VALUES, name="DividendYieldMode").drop(op.get_bind(), checkfirst=True)
    sa.Enum(*_STATUS_VALUES, name="DividendStatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(*_PERIOD_VALUES, name="ReportPeriodType").drop(op.get_bind(), checkfirst=True)