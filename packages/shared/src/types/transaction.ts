/**
 * Transaction（交易记录）类型定义
 *
 * 对应 Prisma model Transaction（transactions 表）。
 * BUY = 买入（现金流为负），SELL = 卖出（现金流为正）。
 * 交易金额 amount 始终 > 0，正负号由 type 决定（XIRR 计算时转换）。
 */

/**
 * 交易类型常量（值对象）
 *
 * 使用 as const 对象 + 派生类型，而非 TypeScript enum，
 * 以保证与 Prisma 生成的 TransactionType 枚举结构兼容
 * （Prisma enum 在类型层面为 'BUY' | 'SELL' 字符串字面量联合，
 *   TypeScript enum 是名义类型，两者无法直接互相赋值）。
 *
 * - BUY：买入，XIRR 现金流为负（资金流出）
 * - SELL：卖出，XIRR 现金流为正（资金流入）
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
  /** 备注，可为空 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}
