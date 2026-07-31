/**
 * Portfolio（投资组合）类型定义
 *
 * 对应 Prisma model Portfolio（portfolios 表）。
 * 一个 User 可拥有多个 Portfolio，所有业务数据（交易/快照/净值/XIRR）
 * 均通过 portfolioId 关联到具体组合。
 *
 * 多币种决策（Q-A04）：v1 仅 CNY，currency 字段在 Portfolio 级别记录，
 * transaction/snapshot 不带币种。后期升级多币种时再扩展。
 */

/**
 * 投资组合实体
 */
export interface Portfolio {
  /** UUID 主键 */
  id: string;
  /** 所属用户 ID（实现数据隔离） */
  userId: string;
  /** 组合名称 */
  name: string;
  /** 组合描述，可为空 */
  description: string | null;
  /**
   * 成立日：首笔买入交易日，首次录入买入交易时自动设置，设置后不可更改。
   * 格式 YYYY-MM-DD，组合未录入首笔买入时为 null。
   */
  baseDate: string | null;
  /** 币种，v1 默认 'CNY' */
  currency: string;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}
