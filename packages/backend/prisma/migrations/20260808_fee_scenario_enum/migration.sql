-- 增量 I-03 · 修正：fee_records.scenario 由 TEXT+CHECK 转换为原生 Postgres enum
-- （与 prisma/schema.prisma `enum FeeScenario { BUY SELL }` 精确对齐，消除 migrate drift）
-- 注意：必须先 DROP 引用该列的 CHECK 约束，再 ALTER TYPE（否则 CHECK 里的 text 字面量
-- 与 enum 无比较操作符导致 42883）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FeeScenario') THEN
    CREATE TYPE "FeeScenario" AS ENUM ('BUY', 'SELL');
  END IF;
END $$;

ALTER TABLE "fee_records" DROP CONSTRAINT IF EXISTS "fee_records_scenario_check";

ALTER TABLE "fee_records"
  ALTER COLUMN "scenario" TYPE "FeeScenario"
  USING ("scenario"::text::"FeeScenario");

ALTER TABLE "fee_records"
  ALTER COLUMN "scenario" SET DEFAULT 'BUY'::"FeeScenario";
