/**
 * DividendRecord（分红记录）类型定义
 *
 * 对应 Prisma model DividendRecord（dividend_records 表）。
 * 持仓模块独立建表，不参与 XIRR/净值计算（C-08 / C-09）。
 *
 * 分红仅作持仓维度的信息记录与统计，不影响收益计算引擎。
 */

/**
 * 分红类型常量（值对象）
 *
 * - CASH：现金分红（有资金流入，仅作记录）
 * - STOCK_DIVIDEND：红利再投（无现金进出，v1 仅记录）
 */
export const DividendType = {
  CASH: 'CASH',
  STOCK_DIVIDEND: 'STOCK_DIVIDEND',
} as const;

/** 分红类型（'CASH' | 'STOCK_DIVIDEND'） */
export type DividendType = (typeof DividendType)[keyof typeof DividendType];

/**
 * 分红记录实体
 */
export interface DividendRecord {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 关联标的 ID */
  securityId: string;
  /** 分红日期 YYYY-MM-DD */
  date: string;
  /** 分红金额（税前） */
  amount: string;
  /** 分红类型 */
  type: DividendType;
  /** 所得税（≥ 0，缺省 0；存量数据迁移后为 0） */
  tax: string;
  /** 净额 = amount − tax（后端统一计算，前端不自行二次计算 K-2） */
  netAmount: string;
  /** 备注 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
}

/**
 * 创建分红记录 DTO
 */
export interface CreateDividendRecordDto {
  /** 关联标的 ID */
  securityId: string;
  /** 分红日期 YYYY-MM-DD */
  date: string;
  /** 分红金额，> 0 */
  amount: string;
  /** 分红类型，默认 CASH */
  type?: DividendType;
  /** 所得税（可选，≥ 0；净额 = amount − tax ≥ 0） */
  tax?: string;
  /** 备注 */
  note?: string;
}

/**
 * 更新分红记录 DTO（I-02 修复后含 type）
 */
export interface UpdateDividendRecordDto {
  securityId?: string;
  date?: string;
  amount?: string;
  tax?: string;
  type?: DividendType;
  note?: string;
}
