-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_date" DATE,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_snapshots" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalAsset" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "daily_xirr" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "xirr_value" DECIMAL(10,8),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_xirr_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "portfolios_user_id_idx" ON "portfolios"("user_id");

-- CreateIndex
CREATE INDEX "transactions_portfolio_id_date_idx" ON "transactions"("portfolio_id", "date");

-- CreateIndex
CREATE INDEX "asset_snapshots_portfolio_id_date_idx" ON "asset_snapshots"("portfolio_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "asset_snapshots_portfolio_id_date_key" ON "asset_snapshots"("portfolio_id", "date");

-- CreateIndex
CREATE INDEX "daily_nav_portfolio_id_date_idx" ON "daily_nav"("portfolio_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_nav_portfolio_id_date_key" ON "daily_nav"("portfolio_id", "date");

-- CreateIndex
CREATE INDEX "daily_xirr_portfolio_id_date_idx" ON "daily_xirr"("portfolio_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_xirr_portfolio_id_date_key" ON "daily_xirr"("portfolio_id", "date");

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_snapshots" ADD CONSTRAINT "asset_snapshots_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_nav" ADD CONSTRAINT "daily_nav_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_xirr" ADD CONSTRAINT "daily_xirr_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
