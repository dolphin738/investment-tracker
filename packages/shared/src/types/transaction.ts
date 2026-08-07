/**
 * Transaction（交易记录）类型定义
 *
 * 对应 Prisma model Transaction（transactions 表）。
 * BUY = 买入（现金流为负），SELL = 卖出（现金流为正）。
 * 交易金额 amount 始终 > 0，正负号由 type 决定（买入为负/卖出为正）。
 * XIRR 计算自方案B 起改读 CashFlow 表（见 incremental-account-v2.md），
 * 本表符号仅供展示与持仓推导，不再参与 XIRR 引擎计算。
 *
 * TransactionType 枚举维持 BUY / SELL 两值不变（C-10 约束）。
 * 分红在持仓模块独立建表（DividendRecord），不进入 Transaction；
 * 费用自 INC-03／INC-04 起物理并入证券买卖流水 security_trades
 * （commission / stampTax / other / feeTotal 四列），不再有独立的 FeeRecord 表。
 */

/**
 * 交易类型常量（值对象）
 *
 * 使用 as const 对象 + 派生类型，而非 TypeScript enum，
 * 以保证与 Prisma 生成的 TransactionType 枚举结构兼容
 * （Prisma enum 在类型层面为 'BUY' | 'SELL' 字符串字面量联合，
 *   TypeScript enum 是名义类型，两者无法直接互相赋值）。
 *
 * - BUY：买入，现金流方向为负（资金流出）
 * - SELL：卖出，现金流方向为正（资金流入）
 *
 * 注：XIRR 引擎自方案B 起改读 CashFlow 表（见 incremental-account-v2.md），
 * 此处的现金流方向标注仅供理解业务语义，不再被 XIRR 计算直接使用。
 */
export const TransactionType = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;

/**
 * 交易类型（'BUY' | 'SELL'）
 *
 * 与 Prisma $Enums.TransactionType 结构兼容，可直接互相赋值。
 * 同时保留 TransactionType.BUY / TransactionType.SELL 值访问，
 * 兼容 class-validator @IsEnum、Swagger @ApiProperty enum、zod z.nativeEnum。
 */
export type TransactionType = typeof TransactionType[keyof typeof TransactionType];

/**
 * 交易记录实体
 */
export interface Transaction {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 交易日期 YYYY-MM-DD（业务日期，不涉及时区） */
  date: string;
  /** 交易类型：买入 / 卖出 */
  type: TransactionType;
  /**
   * 交易金额，始终 > 0。
   * Decimal 以 string 传输，避免 JSON 精度丢失（如 "10000.00"）。
   */
  amount: string;
  /** 🆕 关联标的 ID（可空，向后兼容存量数据） */
  securityId: string | null;
  /** 🆕 交易数量（可空） */
  quantity: string | null;
  /** 🆕 成交单价（可空） */
  price: string | null;
  /** 🆕 手续费（可空，信息记录，已包含在 amount 内） */
  fee: string | null;
  /** 备注，可为空 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * 创建交易 DTO
 */
export interface CreateTransactionDto {
  /** 交易日期 YYYY-MM-DD */
  date: string;
  /** 交易类型：买入 / 卖出 */
  type: TransactionType;
  /** 交易金额，> 0 */
  amount: string;
  /** 🆕 关联标的 ID（可选） */
  securityId?: string;
  /** 🆕 交易数量（可选） */
  quantity?: string;
  /** 🆕 成交单价（可选） */
  price?: string;
  /** 🆕 手续费（可选） */
  fee?: string;
  /** 备注（可选） */
  note?: string;
}

/**
 * 更新交易 DTO（所有字段可选）
 */
export interface UpdateTransactionDto {
  /** 交易日期 YYYY-MM-DD */
  date?: string;
  /** 交易类型 */
  type?: TransactionType;
  /** 交易金额 */
  amount?: string;
  /** 🆕 关联标的 ID */
  securityId?: string | null;
  /** 🆕 交易数量 */
  quantity?: string | null;
  /** 🆕 成交单价 */
  price?: string | null;
  /** 🆕 手续费 */
  fee?: string | null;
  /** 备注 */
  note?: string | null;
}
