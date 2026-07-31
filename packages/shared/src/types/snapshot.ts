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
}
