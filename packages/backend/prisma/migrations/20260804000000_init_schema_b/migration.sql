-- ============================================================
-- init_schema_b — 方案B 完整 Schema 初始迁移
-- 对齐 ARCH §3.1 Prisma Schema 完整定义
-- ============================================================

-- 1. 枚举类型
CREATE TYPE "CashFlowType" AS ENUM ('BUY', 'SELL');
CREATE TYPE "SecurityType" AS ENUM ('STOCK', 'FUND', 'BOND', 'OTHER', 'CASH');
CREATE TYPE "SecuritySide" AS ENUM ('BUY_SEC', 'SELL_SEC');
CREATE TYPE "SnapshotSource" AS ENUM ('DERIVED', 'MANUAL');
CREATE TYPE "SnapshotValuation" AS ENUM ('EXACT', 'CARRIED_FORWARD', 'COST_BASED', 'MANUAL_INPUT');
CREATE TYPE "DividendType" AS ENUM ('CASH', 'STOCK_DIVIDEND');
CREATE TYPE "FeeType" AS ENUM ('COMMISSION', 'STAMP_TAX', 'OTHER');

-- 2. users
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "avatar" VARCHAR(512),
    "phone" VARCHAR(20),
    "bio" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- 3. portfolios
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_date" DATE,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "portfolios_user_id_idx" ON "portfolios"("user_id");
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. cashflows（出入金流水，XIRR 现金流唯一来源）
CREATE TABLE "cashflows" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "CashFlowType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cashflows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cashflows_portfolio_id_date_idx" ON "cashflows"("portfolio_id", "date");
ALTER TABLE "cashflows" ADD CONSTRAINT "cashflows_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. securities（标的主数据）
CREATE TABLE "securities" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SecurityType" NOT NULL DEFAULT 'STOCK',
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "securities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "securities_portfolio_id_code_key" ON "securities"("portfolio_id", "code");
ALTER TABLE "securities" ADD CONSTRAINT "securities_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. security_trades（证券买卖流水，方案B 持仓推导唯一来源）
CREATE TABLE "security_trades" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "side" "SecuritySide" NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,
    "fee" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_trades_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "security_trades_portfolio_id_date_idx" ON "security_trades"("portfolio_id", "date");
CREATE INDEX "security_trades_security_id_date_idx" ON "security_trades"("security_id", "date");
ALTER TABLE "security_trades" ADD CONSTRAINT "security_trades_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_trades" ADD CONSTRAINT "security_trades_security_id_fkey"
    FOREIGN KEY ("security_id") REFERENCES "securities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. security_prices（标的最新价，向前沿用）
CREATE TABLE "security_prices" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,
    "asOf" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_prices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "security_prices_portfolio_id_security_id_asOf_idx" ON "security_prices"("portfolio_id", "security_id", "asOf");
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_security_id_fkey"
    FOREIGN KEY ("security_id") REFERENCES "securities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. cash_balances（现金余额，独立 · 零联动）
CREATE TABLE "cash_balances" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "asOf" DATE NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_balances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cash_balances_portfolio_id_asOf_idx" ON "cash_balances"("portfolio_id", "asOf");
ALTER TABLE "cash_balances" ADD CONSTRAINT "cash_balances_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 9. asset_snapshots（总资产每日唯一记录，派生层 + 手工）
CREATE TABLE "asset_snapshots" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalAsset" DECIMAL(18,2) NOT NULL,
    "marketValue" DECIMAL(18,2),
    "cashBalance" DECIMAL(18,2),
    "source" "SnapshotSource" NOT NULL,
    "valuationFlag" "SnapshotValuation" NOT NULL,
    "note" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_snapshots_portfolio_id_date_key" ON "asset_snapshots"("portfolio_id", "date");
CREATE INDEX "asset_snapshots_portfolio_id_date_idx" ON "asset_snapshots"("portfolio_id", "date");
ALTER TABLE "asset_snapshots" ADD CONSTRAINT "asset_snapshots_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 10. daily_nav（每日净值）
CREATE TABLE "daily_nav" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "unit_nav" DECIMAL(12,6) NOT NULL,
    "cumulative_nav" DECIMAL(12,6) NOT NULL,
    "year_nav" DECIMAL(12,6) NOT NULL,
    "shares" DECIMAL(18,6) NOT NULL,
    "base_cumulative_nav" DECIMAL(12,6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_nav_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "daily_nav_portfolio_id_date_key" ON "daily_nav"("portfolio_id", "date");
CREATE INDEX "daily_nav_portfolio_id_date_idx" ON "daily_nav"("portfolio_id", "date");
ALTER TABLE "daily_nav" ADD CONSTRAINT "daily_nav_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 11. daily_xirr（每日 XIRR）
CREATE TABLE "daily_xirr" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "xirr_value" DECIMAL(20,8),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_xirr_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "daily_xirr_portfolio_id_date_key" ON "daily_xirr"("portfolio_id", "date");
CREATE INDEX "daily_xirr_portfolio_id_date_idx" ON "daily_xirr"("portfolio_id", "date");
ALTER TABLE "daily_xirr" ADD CONSTRAINT "daily_xirr_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 12. dividend_records（分红记录，不参与收益计算 C-08）
CREATE TABLE "dividend_records" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "type" "DividendType" NOT NULL DEFAULT 'CASH',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dividend_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dividend_records_portfolio_id_date_idx" ON "dividend_records"("portfolio_id", "date");
CREATE INDEX "dividend_records_security_id_date_idx" ON "dividend_records"("security_id", "date");
ALTER TABLE "dividend_records" ADD CONSTRAINT "dividend_records_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dividend_records" ADD CONSTRAINT "dividend_records_security_id_fkey"
    FOREIGN KEY ("security_id") REFERENCES "securities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 13. fee_records（费用记录，不参与收益计算 C-09）
CREATE TABLE "fee_records" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "type" "FeeType" NOT NULL DEFAULT 'OTHER',
    "transaction_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "fee_records_portfolio_id_date_idx" ON "fee_records"("portfolio_id", "date");
CREATE INDEX "fee_records_security_id_date_idx" ON "fee_records"("security_id", "date");
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_portfolio_id_fkey"
    FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_security_id_fkey"
    FOREIGN KEY ("security_id") REFERENCES "securities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 14. user_preferences（用户偏好设置）
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "default_portfolio_id" TEXT,
    "default_granularity" TEXT NOT NULL DEFAULT 'month',
    "default_date_range" TEXT NOT NULL DEFAULT '1y',
    "aggregation" TEXT NOT NULL DEFAULT 'last',
    "week_starts_on" INTEGER NOT NULL DEFAULT 1,
    "nav_decimals" INTEGER NOT NULL DEFAULT 4,
    "xirr_decimals" INTEGER NOT NULL DEFAULT 2,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "stale_days" INTEGER NOT NULL DEFAULT 3,
    "show_liquidated" BOOLEAN NOT NULL DEFAULT false,
    "cost_basis_view" TEXT NOT NULL DEFAULT 'avg',
    "dashboard_layout" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
