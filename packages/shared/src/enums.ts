/**
 * 共享枚举定义
 *
 * 所有枚举值对齐 ARCH §5.2 与 PRD 附录 D 数据模型。
 * 枚举名称与 Prisma Schema 中的 enum 保持一致的语义。
 */

// ==================== 出入金类型 ====================

/** 出入金流水类型：BUY=存入（现金流为负），SELL=取出（现金流为正） */
export enum CashFlowType {
  BUY = 'BUY',
  SELL = 'SELL',
}

// ==================== 证券买卖方向 ====================

/** 证券买卖方向（严禁复用 CashFlowType，C-10） */
export enum SecuritySide {
  BUY_SEC = 'BUY_SEC',
  SELL_SEC = 'SELL_SEC',
}

// ==================== 快照来源 ====================

/** 资产快照来源：DERIVED=系统自动派生，MANUAL=用户手工录入 */
export enum SnapshotSource {
  DERIVED = 'DERIVED',
  MANUAL = 'MANUAL',
}

// ==================== 快照估值标识 ====================

/** 资产快照估值方式标识 */
export enum SnapshotValuation {
  /** 当日有全部持仓市价 → 精确估值 */
  EXACT = 'EXACT',
  /** 无最新价 → 沿用前值 */
  CARRIED_FORWARD = 'CARRIED_FORWARD',
  /** 仅有成本价 → 成本法估值 */
  COST_BASED = 'COST_BASED',
  /** 手工录入 → 用户自行判断 */
  MANUAL_INPUT = 'MANUAL_INPUT',
}

// ==================== 查询粒度与聚合方式 ====================

/** 查询时间粒度 */
export enum QueryGranularity {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
}

/** 聚合方式：last=取期末值，avg=取区间均值 */
export enum AggregationMethod {
  LAST = 'last',
  AVG = 'avg',
}
