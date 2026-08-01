-- CreateEnum
CREATE TYPE "SecurityType" AS ENUM ('STOCK', 'FUND', 'BOND', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "DividendType" AS ENUM ('CASH', 'STOCK_DIVIDEND');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('COMMISSION', 'STAMP_TAX', 'OTHER');

-- AlterTable
ALTER TABLE "portfolios" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "fee" DECIMAL(18,2),
ADD COLUMN     "price" DECIMAL(18,6),
ADD COLUMN     "quantity" DECIMAL(18,6),
ADD COLUMN     "security_id" TEXT;

-- CreateTable
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

-- CreateTable
CREATE TABLE "holdings" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "avg_cost" DECIMAL(18,6) NOT NULL,
    "market_price" DECIMAL(18,6) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "securities_portfolio_id_idx" ON "securities"("portfolio_id");

-- CreateIndex
CREATE UNIQUE INDEX "securities_portfolio_id_code_key" ON "securities"("portfolio_id", "code");

-- CreateIndex
CREATE INDEX "holdings_portfolio_id_date_idx" ON "holdings"("portfolio_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holdings_security_id_date_key" ON "holdings"("security_id", "date");

-- CreateIndex
CREATE INDEX "dividend_records_portfolio_id_date_idx" ON "dividend_records"("portfolio_id", "date");

-- CreateIndex
CREATE INDEX "dividend_records_security_id_date_idx" ON "dividend_records"("security_id", "date");

-- CreateIndex
CREATE INDEX "fee_records_portfolio_id_date_idx" ON "fee_records"("portfolio_id", "date");

-- CreateIndex
CREATE INDEX "fee_records_security_id_date_idx" ON "fee_records"("security_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE INDEX "transactions_portfolio_id_type_idx" ON "transactions"("portfolio_id", "type");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "securities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "securities" ADD CONSTRAINT "securities_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividend_records" ADD CONSTRAINT "dividend_records_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividend_records" ADD CONSTRAINT "dividend_records_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
