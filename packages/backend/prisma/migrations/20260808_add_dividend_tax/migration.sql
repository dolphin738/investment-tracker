-- ============================================================
-- add_dividend_tax — 分红记录增加「所得税」字段（增量设计 C-2 / PRD K-1）
--
-- 语义：dividend_records 表新增 tax 列，存储所得税（NUMERIC(18,2)）。
-- - 净额口径：netAmount = amount − tax，恒 ≥ 0（前后端双闸校验）
-- - 存量行默认 tax = 0（净额 = 税前 = 旧 amount，Q-1 默认）
-- - 零风险：NOT NULL DEFAULT 0 对既有数据无破坏
-- ============================================================

ALTER TABLE "dividend_records" ADD COLUMN "tax" NUMERIC(18,2) NOT NULL DEFAULT 0;
