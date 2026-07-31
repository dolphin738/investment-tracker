/**
 * DailyNav（每日净值）类型定义
 *
 * 对应 Prisma model DailyNav（daily_nav 表）。
 * 采用公募基金标准"份额-净值"模型：
 * - unit_nav：当日单位净值 = 当日资产快照 / 上日末份额（成立日 = 1.0000）
 * - cumulative_nav：累计净值 = 单位净值（v1 无分红）
 * - year_nav：当年净值 = 累计净值 / base_cumulative_nav（当年首日 = 1.0000）
 * - shares：当日末总份额 = 上日末份额 + 买入份额 - 卖出份额
 * - base_cumulative_nav：当年基准累计净值（上年末最后交易日累计净值，年内不变）
 *
 * 唯一约束：每个组合每日仅一条净值记录（portfolioId + date）。
 * 精度：净值 NUMERIC(12,6)，份额 NUMERIC(18,6)，存储 6 位小数确保计算精度。
 */

/**
 * 每日净值记录实体
 */
export interface DailyNav {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 当日单位净值，Decimal as string（如 "1.200000"） */
  unitNav: string;
  /** 累计净值，Decimal as string（v1 = 单位净值） */
  cumulativeNav: string;
  /** 当年净值，Decimal as string（如 "1.050000"） */
  yearNav: string;
  /** 当日末总份额，Decimal as string（如 "10000.000000"） */
  shares: string;
  /** 当年基准累计净值，null 表示成立日（base = 1.0） */
  baseCumulativeNav: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * 净值时间序列数据点（四维度查询返回）
 *
 * 对应 API: GET /portfolios/:portfolioId/nav
 * 按 granularity（day/week/month/year）聚合后返回。
 */
export interface NavSeriesPoint {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 累计净值，聚合后为 number，null 表示无数据 */
  cumulativeNav: number | null;
  /** 当年净值，null 表示无数据 */
  yearNav: number | null;
  /** 份额，null 表示无数据 */
  shares: number | null;
  /** 显示标签（如 "2025-03" 或 "2025-W12"） */
  label: string;
}
