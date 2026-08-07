/*
  Warnings:

  - You are about to drop the column `fee` on the `security_trades` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `security_trades` table. All the data in the column will be lost.
  - You are about to drop the `fee_records` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `cost_price` to the `security_trades` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "fee_records" DROP CONSTRAINT "fee_records_portfolio_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_records" DROP CONSTRAINT "fee_records_security_id_fkey";

-- AlterTable
ALTER TABLE "security_trades" DROP COLUMN "fee",
DROP COLUMN "price",
ADD COLUMN     "commission" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cost_price" DECIMAL(18,6) NOT NULL,
ADD COLUMN     "fee_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "other" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "stampTax" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "fee_records";

-- DropEnum
DROP TYPE IF EXISTS "FeeScenario";

-- DropEnum
DROP TYPE "FeeType";
