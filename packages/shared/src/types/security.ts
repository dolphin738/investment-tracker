/**
 * Security（标的主数据）类型定义
 *
 * 对应 Prisma model Security（securities 表）。
 * 每个投资组合下管理一组标的，作为持仓/分红/费用的关联基础。
 *
 * 数据隔离：Security 通过 portfolioId 关联到 Portfolio，
 * CRUD 操作均需 JWT 认证 + userId 过滤。
 */

/**
 * 标的类型常量（值对象）
 *
 * 使用 as const 对象 + 派生类型，与 Prisma $Enums.SecurityType 兼容。
 * - STOCK：股票
 * - FUND：基金
 * - BOND：债券
 * - CASH：现金
 * - OTHER：其他
 */
export const SecurityType = {
  STOCK: 'STOCK',
  FUND: 'FUND',
  BOND: 'BOND',
  CASH: 'CASH',
  OTHER: 'OTHER',
} as const;

/** 标的类型（'STOCK' | 'FUND' | 'BOND' | 'CASH' | 'OTHER'） */
export type SecurityType = (typeof SecurityType)[keyof typeof SecurityType];

/**
 * 标的实体
 */
export interface Security {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 标的代码，如 "600519"、"510300" */
  code: string;
  /** 标的名称 */
  name: string;
  /** 标的类型 */
  type: SecurityType;
  /** 币种，默认 "CNY" */
  currency: string;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * 创建标的 DTO
 */
export interface CreateSecurityDto {
  /** 标的代码（同一组合内唯一） */
  code: string;
  /** 标的名称，必填，长度 ≤ 50 */
  name: string;
  /** 标的类型，默认 STOCK */
  type?: SecurityType;
  /** 币种，默认 "CNY" */
  currency?: string;
}

/**
 * 更新标的 DTO（所有字段可选）
 */
export interface UpdateSecurityDto {
  /** 标的代码 */
  code?: string;
  /** 标的名称 */
  name?: string;
  /** 标的类型 */
  type?: SecurityType;
  /** 币种 */
  currency?: string;
}

/**
 * 持仓快照实体（Holding）
 *
 * 对应 Prisma model Holding（holdings 表）。
 * 每日持仓快照，标的 × 日期唯一。
 * marketValue / profit / profitRate / weight 为派生值，不落库。
 */
export interface Holding {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 关联标的 ID */
  securityId: string;
  /** 快照日期 YYYY-MM-DD */
  date: string;
  /** 持仓数量 */
  quantity: string;
  /** 移动加权平均成本价 */
  avgCost: string;
  /** 现价（手工录入） */
  marketPrice: string;
  /** 备注 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * 持仓响应（含派生字段）
 *
 * 后端 service 计算后返回，前端直接使用。
 */
export interface HoldingResponse {
  /** UUID 主键 */
  id: string;
  /** 关联标的 ID */
  securityId: string;
  /** 标的名称（JOIN 查询） */
  securityName: string;
  /** 标的代码（JOIN 查询） */
  securityCode: string;
  /** 标的类型（JOIN 查询） */
  securityType: SecurityType;
  /** 快照日期 YYYY-MM-DD */
  date: string;
  /** 持仓数量 */
  quantity: string;
  /** 移动加权平均成本价 */
  avgCost: string;
  /** 现价（手工录入） */
  marketPrice: string;
  /** 派生：成本额 = quantity × avgCost */
  costAmount: string;
  /** 派生：市值 = quantity × marketPrice */
  marketValue: string;
  /** 派生：浮动盈亏 = marketValue − costAmount */
  profit: string;
  /** 派生：盈亏率 = profit / costAmount */
  profitRate: string;
  /** 派生：占比 = marketValue / ΣmarketValue */
  weight: string;
  /** 备注 */
  note: string | null;
}

/**
 * 持仓汇总信息
 */
export interface HoldingsAggregate {
  /** 快照日期 YYYY-MM-DD */
  date: string;
  /** 总市值 = Σ(quantity × marketPrice) */
  totalMarketValue: string;
  /** 总成本 = Σ(quantity × avgCost) */
  totalCost: string;
  /** 总浮动盈亏 = totalMarketValue − totalCost */
  totalProfit: string;
  /** 总盈亏率 = totalProfit / totalCost */
  totalProfitRate: string;
  /** 标的数量 */
  securityCount: number;
  /** 🆕 手工录入现金余额（D-04） */
  cashBalance: string;
  /** 🆕 组合总市值 = totalMarketValue + cashBalance（D-01） */
  combinedTotal: string;
}

/**
 * 持仓 Upsert DTO
 */
export interface UpsertHoldingDto {
  /** 快照日期 YYYY-MM-DD */
  date: string;
  /** 关联标的 ID */
  securityId: string;
  /** 持仓数量，≥ 0 */
  quantity: string;
  /** 移动加权平均成本价，> 0 */
  avgCost: string;
  /** 现价，> 0 */
  marketPrice: string;
  /** 备注 */
  note?: string;
}

/**
 * 持仓查询参数
 */
export interface HoldingQueryDto {
  /** 快照日期 YYYY-MM-DD（默认最新有数据的一天） */
  date?: string;
  /** 标的类型筛选（多选） */
  types?: SecurityType[];
}
