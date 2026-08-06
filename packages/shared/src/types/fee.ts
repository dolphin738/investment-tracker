/**
 * FeeRecord（费用记录）类型定义
 *
 * 对应 Prisma model FeeRecord（fee_records 表）。
 * 持仓模块独立建表，不参与 XIRR/净值计算（C-08 / C-09）。
 *
 * 费用仅作持仓维度的信息记录与统计，不影响收益计算引擎。
 * 交易中的 amount 字段已是含费用的实际资金进出额，fee 为信息记录。
 */

/**
 * 费用类型常量（值对象）
 *
 * - COMMISSION：佣金
 * - STAMP_TAX：印花税
 * - OTHER：其他费用
 */
export const FeeType = {
  COMMISSION: 'COMMISSION',
  STAMP_TAX: 'STAMP_TAX',
  OTHER: 'OTHER',
} as const;

/** 费用类型（'COMMISSION' | 'STAMP_TAX' | 'OTHER'） */
export type FeeType = (typeof FeeType)[keyof typeof FeeType];

/**
 * 费用场景常量（值对象，I-03）
 *
 * - BUY：买入时费用
 * - SELL：卖出时费用
 *
 * ⚠️ 三处值必须一致（共享知识 §8）：
 * 后端 prisma/schema.prisma `enum FeeScenario { BUY SELL }`（唯一 DB 真源）、
 * shared 此处 const + type、web api/types.ts enum。
 */
export const FeeScenario = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;

/** 费用场景（'BUY' | 'SELL'） */
export type FeeScenario = (typeof FeeScenario)[keyof typeof FeeScenario];

/**
 * 费用记录实体
 */
export interface FeeRecord {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 关联标的 ID */
  securityId: string;
  /** 费用发生日期 YYYY-MM-DD */
  date: string;
  /** 费用金额 */
  amount: string;
  /** 费用类型 */
  type: FeeType;
  /** 费用场景（BUY=买入时 / SELL=卖出时，I-03） */
  scenario: FeeScenario;
  /** 关联交易 ID（可选） */
  transactionId: string | null;
  /** 备注 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
}

/**
 * 创建费用记录 DTO
 */
export interface CreateFeeRecordDto {
  /** 关联标的 ID */
  securityId: string;
  /** 费用发生日期 YYYY-MM-DD */
  date: string;
  /** 费用金额，> 0 */
  amount: string;
  /** 费用类型，默认 OTHER */
  type?: FeeType;
  /** 费用场景（BUY=买入时 / SELL=卖出时，缺省按 transactionId 推断，无法推断默认 BUY） */
  scenario?: FeeScenario;
  /** 关联交易 ID（可选） */
  transactionId?: string;
  /** 备注 */
  note?: string;
}

/**
 * 更新费用记录 DTO（I-03 · PATCH /fees/:id，全可选）
 */
export interface UpdateFeeRecordDto {
  /** 关联标的 ID */
  securityId?: string;
  /** 费用发生日期 YYYY-MM-DD */
  date?: string;
  /** 费用金额，> 0 */
  amount?: string;
  /** 费用类型 */
  type?: FeeType;
  /** 费用场景 */
  scenario?: FeeScenario;
  /** 备注 */
  note?: string;
}

/**
 * 费用列表 grouped=1 聚合行（I-03 / Q-3：明细行各自保留 transactionId，
 * 聚合行携带 transactionIds[] 全量去重）
 */
export interface FeeGroupedRow {
  /** `${securityId}|${date}|${scenario}|${type}` */
  mergeKey: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  /** YYYY-MM-DD */
  date: string;
  scenario: FeeScenario;
  type: FeeType;
  /** Σ 金额，toFixed(2) */
  amount: string;
  /** 组成笔数 */
  count: number;
  /** 关联流水 ID 去重列表 */
  transactionIds: string[];
}
