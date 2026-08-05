/**
 * AssetSnapshot（资产快照）类型定义
 *
 * 对应 Prisma model AssetSnapshot（asset_snapshots 表）。
 * 每个交易日记录一条，当日持仓总市值。
 * 资产快照是触发当日净值与 XIRR 计算的前提——没有当日快照则不计算。
 *
 * 唯一约束：每个组合每日仅一条快照（portfolioId + date），重复录入时 upsert 覆盖。
 */

/**
 * 资产快照实体
 */
export interface AssetSnapshot {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 快照日期 YYYY-MM-DD */
  date: string;
  /**
   * 当日持仓总市值，始终 > 0。
   * Decimal 以 string 传输（如 "12000.00"）。
   */
  totalAsset: string;
  /** 备注，可为空 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
  /**
   * 该日**系统派生**的总资产（Decimal 字符串），用于快照页
   * 「手工值 vs 派生值 vs 差异」三列对比（AL-054 / 决策 Q-1 甲）。
   *
   * 语义 = 「若该日不使用手工快照，系统按 持仓×行情 + 现金 推导出的总资产」，
   * 即 `AssetValuationService.computeDerived(portfolioId, date).totalAsset`。
   *
   * 取值规则（后端 `SnapshotService.attachDerivedTotalAsset`）：
   * - `source === 'DERIVED'` → 直接等于 `totalAsset`（不重复计算）；
   * - `source === 'MANUAL'`  → 实时派生计算的结果；
   * - 计算失败 / 数据缺失   → `null`（**列表仍返回 200，绝不因此抛错**）。
   *
   * 🔴 本字段是**运行时计算的响应字段，不落库**（Prisma schema 零变更）。
   */
  derivedTotalAsset?: string | null;
}
