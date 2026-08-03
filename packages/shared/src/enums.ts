/**
 * 共享枚举定义
 *
 * 所有枚举值对齐 ARCH §5.2 与 PRD 附录 D 数据模型。
 * 枚举名称与 Prisma Schema 中的 enum 保持一致的语义。
 *
 * ⚠️ 统一使用 `as const` 对象 + 派生类型，而非 TypeScript `enum`：
 * - 本包通过 `exports` 直接以 .ts 源码形式被 Node ESM 运行时加载（type stripping），
 *   TS `enum` 属于非可擦除语法（需 --experimental-transform-types），而
 *   `as const` 对象是纯 JS，可被任意运行时直接加载。
 * - 与 Prisma 生成的字符串字面量联合（如 'BUY' | 'SELL'）结构兼容，可互相赋值；
 *   TS `enum` 是名义类型，无法与 Prisma 枚举直接互操作。
 *   （与 types/transaction.ts 中 TransactionType 的处理保持一致。）
 */

// ==================== 出入金类型 ====================

/** 出入金流水类型：BUY=存入（现金流为负），SELL=取出（现金流为正） */
export const CashFlowType = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;

/** 出入金流水类型（'BUY' | 'SELL'） */
export type CashFlowType = typeof CashFlowType[keyof typeof CashFlowType];

// ==================== 证券买卖方向 ====================

/** 证券买卖方向（严禁复用 CashFlowType，C-10） */
export const SecuritySide = {
  BUY_SEC: 'BUY_SEC',
  SELL_SEC: 'SELL_SEC',
} as const;

/** 证券买卖方向（'BUY_SEC' | 'SELL_SEC'） */
export type SecuritySide = typeof SecuritySide[keyof typeof SecuritySide];

// ==================== 快照来源 ====================

/** 资产快照来源：DERIVED=系统自动派生，MANUAL=用户手工录入 */
export const SnapshotSource = {
  DERIVED: 'DERIVED',
  MANUAL: 'MANUAL',
} as const;

/** 资产快照来源（'DERIVED' | 'MANUAL'） */
export type SnapshotSource = typeof SnapshotSource[keyof typeof SnapshotSource];

// ==================== 快照估值标识 ====================

/** 资产快照估值方式标识 */
export const SnapshotValuation = {
  /** 当日有全部持仓市价 → 精确估值 */
  EXACT: 'EXACT',
  /** 无最新价 → 沿用前值 */
  CARRIED_FORWARD: 'CARRIED_FORWARD',
  /** 仅有成本价 → 成本法估值 */
  COST_BASED: 'COST_BASED',
  /** 手工录入 → 用户自行判断 */
  MANUAL_INPUT: 'MANUAL_INPUT',
} as const;

/** 资产快照估值方式标识（'EXACT' | 'CARRIED_FORWARD' | 'COST_BASED' | 'MANUAL_INPUT'） */
export type SnapshotValuation =
  typeof SnapshotValuation[keyof typeof SnapshotValuation];

// ==================== 查询粒度与聚合方式 ====================

/** 查询时间粒度 */
export const QueryGranularity = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
} as const;

/** 查询时间粒度（'day' | 'week' | 'month' | 'year'） */
export type QueryGranularity =
  typeof QueryGranularity[keyof typeof QueryGranularity];

/** 聚合方式：last=取期末值，avg=取区间均值 */
export const AggregationMethod = {
  LAST: 'last',
  AVG: 'avg',
} as const;

/** 聚合方式（'last' | 'avg'） */
export type AggregationMethod =
  typeof AggregationMethod[keyof typeof AggregationMethod];
