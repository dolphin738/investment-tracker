-- 增量 I-03：fee_records 新增 scenario 列（FeeScenario { BUY, SELL }，非空）
-- 架构裁决 Q-4：存量数据能按 transactionId 推断则推断（SecurityTrade.side），否则默认 BUY。
-- 架构裁决 Q-8：不采纳 DB 层唯一约束，合并走展示层聚合；scenario 保留安全网默认 BUY。
-- 回填逻辑幂等可重跑（本库为开发/测试库）。

-- 1) 加列（可空 → 回填后收紧 NOT NULL）
ALTER TABLE "fee_records" ADD COLUMN "scenario" TEXT;

-- 2) 能按 transactionId 推断的：取 SecurityTrade.side（BUY_SEC → BUY，SELL_SEC → SELL）
UPDATE "fee_records" fr
SET "scenario" = CASE WHEN st."side" = 'BUY_SEC' THEN 'BUY' ELSE 'SELL' END
FROM "security_trades" st
WHERE fr."transaction_id" = st."id";

-- 3) 无法推断的（transactionId 为 NULL / 指向已删流水）：默认 BUY（裁决 Q-4 默认策略）
UPDATE "fee_records" SET "scenario" = 'BUY' WHERE "scenario" IS NULL;

-- 4) 收紧 + 校验约束
ALTER TABLE "fee_records" ALTER COLUMN "scenario" SET NOT NULL;
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_scenario_check"
  CHECK ("scenario" IN ('BUY', 'SELL'));

-- 5) 索引（与 schema.prisma @@index([portfolioId, scenario, date]) 对齐；
--    若 prisma migrate 已自动生成则此处幂等跳过）
CREATE INDEX IF NOT EXISTS "fee_records_portfolio_id_scenario_date_idx"
  ON "fee_records"("portfolio_id", "scenario", "date");
