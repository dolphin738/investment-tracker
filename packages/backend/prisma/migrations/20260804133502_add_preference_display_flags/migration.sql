-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "amount_abbrev" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "amount_thousands" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cash_hint_on_cashflow" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cash_hint_on_trade" BOOLEAN NOT NULL DEFAULT true;
