/**
 * 核心数据类型定义
 *
 * 所有类型对齐 ARCH §5.2 与 PRD 附录 D 数据模型（方案B）。
 * Decimal 字段统一以 string 传输，避免 JS 浮点精度损失。
 * 日期字段统一为 YYYY-MM-DD 格式字符串。
 */

import type {
  CashFlowType,
  SecuritySide,
  SnapshotSource,
  SnapshotValuation,
} from './enums.ts';

// ==================== 出入金流水（XIRR 现金流唯一来源）====================

export interface CashFlow {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** BUY=存入（现金流为负），SELL=取出（现金流为正） */
  type: CashFlowType;
  /** 金额 Decimal 字符串，始终 > 0 */
  amount: string;
  /** 备注 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

// ==================== 证券买卖流水（方案B 持仓推导唯一来源）====================

export interface SecurityTrade {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 标的 ID */
  securityId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** BUY_SEC / SELL_SEC */
  side: SecuritySide;
  /** 交易数量 Decimal 字符串，始终 > 0 */
  quantity: string;
  /** 成交单价 Decimal 字符串 */
  price: string;
  /** 费用 Decimal 字符串（信息记录，计入成本，不回冲） */
  fee: string;
  /** 备注 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

// ==================== 标的最新价（向前沿用）====================

export interface SecurityPrice {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 标的 ID */
  securityId: string;
  /** 价格 Decimal 字符串 */
  price: string;
  /** 价格日期 YYYY-MM-DD（语义：asOf ≤ 目标日期的最后一条为当前值） */
  asOf: string;
  /** 创建时间 ISO 8601 */
  createdAt: string;
}

// ==================== 现金余额（独立 · 零联动）====================

export interface CashBalance {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 余额 Decimal 字符串 */
  amount: string;
  /** 余额日期 YYYY-MM-DD（语义：asOf ≤ 目标日期的最后一条为当前值，首条之前 = 0） */
  asOf: string;
  /** 备注 */
  note: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
}

// ==================== 投资组合 ====================

export interface Portfolio {
  /** UUID 主键 */
  id: string;
  /** 所属用户 ID（实现数据隔离） */
  userId: string;
  /** 组合名称 */
  name: string;
  /** 组合描述 */
  description: string | null;
  /** 成立日 YYYY-MM-DD（首笔出入金日，设后不可改） */
  baseDate: string | null;
  /** 币种，默认 CNY */
  currency: string;
  /** 归档时间 ISO 8601，null 表示活跃 */
  archivedAt: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

// ==================== 总资产每日唯一记录（派生层 + 手工）====================

export interface AssetSnapshot {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 快照日期 YYYY-MM-DD */
  date: string;
  /** 当日总资产 Decimal 字符串 */
  totalAsset: string;
  /** 拆解：持仓市值合计，null 表示未拆解 */
  marketValue: string | null;
  /** 拆解：当日现金余额，null 表示未拆解 */
  cashBalance: string | null;
  /** 来源：DERIVED（自动派生）/ MANUAL（手工录入） */
  source: SnapshotSource;
  /** 估值标识 */
  valuationFlag: SnapshotValuation;
  /** 备注 */
  note: string | null;
  /** 记录时间 ISO 8601 */
  recordedAt: string;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

// ==================== 每日净值 ====================

export interface DailyNav {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 单位净值 Decimal 字符串 */
  unitNav: string;
  /** 累计净值 Decimal 字符串 */
  cumulativeNav: string;
  /** 当年净值 Decimal 字符串 */
  yearNav: string;
  /** 份额 Decimal 字符串 */
  shares: string;
  /** 当年基准累计净值，null 表示成立日（base=1.0） */
  baseCumulativeNav: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

// ==================== 每日 XIRR ====================

export interface DailyXirr {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 累计 XIRR 年化收益率（小数形式），null = 数据不足 */
  xirrValue: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

// ==================== 查询响应数据点 ====================

/** 净值时间序列数据点 */
export interface NavSeriesPoint {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 累计净值，null 表示无数据 */
  cumulativeNav: number | null;
  /** 当年净值，null 表示无数据 */
  yearNav: number | null;
  /** 份额，null 表示无数据 */
  shares: number | null;
  /** 显示标签（如 "2025-03" 或 "2025-W12"） */
  label: string;
}

/** XIRR 时间序列数据点 */
export interface XirrSeriesPoint {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** XIRR 值，null 表示数据不足 */
  xirrValue: number | null;
  /** 显示标签（如 "2025-03" 或 "2025-W12"） */
  label: string;
}

/** 组合统计摘要（Dashboard 卡片） */
export interface PortfolioSummary {
  /** 累计 XIRR（小数形式，如 0.1234 = 12.34%），null 表示数据不足 */
  cumulativeXirr: number | null;
  /** 总收益率 = (最新累计净值 - 1) * 100%，null 表示无净值数据 */
  totalReturnRate: number | null;
  /** 当年收益率 = (最新当年净值 - 1) * 100%，null 表示无数据 */
  yearReturnRate: number | null;
  /** 最大回撤（P1，v1 可返回 null） */
  maxDrawdown: number | null;
  /** 最新有数据的日期 YYYY-MM-DD */
  latestDate: string;
  /** 成立日 YYYY-MM-DD */
  inceptionDate: string;
}
