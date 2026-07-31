/**
 * DailyXirr（每日 XIRR）类型定义
 *
 * 对应 Prisma model DailyXirr（daily_xirr 表）。
 * XIRR = 扩展内部收益率，求解使所有现金流 NPV = 0 的年化折现率 r。
 * 现金流：买入=负，卖出=正，当日资产快照=正终值。
 *
 * xirr_value 为小数形式（如 0.12345678 表示 12.34%），
 * 全同号现金流时为 null（数据不足或无法求解）。
 *
 * 精度：NUMERIC(10,8)，存储 8 位小数。
 */

/**
 * 每日 XIRR 记录实体
 */
export interface DailyXirr {
  /** UUID 主键 */
  id: string;
  /** 所属组合 ID */
  portfolioId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /**
   * 累计 XIRR 年化收益率（小数形式，如 "0.12345678" = 12.34%）。
   * null 表示数据不足（全同号现金流或现金流 < 2 条）。
   */
  xirrValue: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * XIRR 时间序列数据点（四维度查询返回）
 *
 * 对应 API: GET /portfolios/:portfolioId/xirr
 * 按 granularity（day/week/month/year）聚合后返回。
 */
export interface XirrSeriesPoint {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** XIRR 值，聚合后为 number，null 表示数据不足 */
  xirrValue: number | null;
  /** 显示标签（如 "2025-03" 或 "2025-W12"） */
  label: string;
}

/**
 * 组合统计摘要（Dashboard 卡片数据）
 *
 * 对应 API: GET /portfolios/:portfolioId/summary
 */
export interface PortfolioSummary {
  /** 累计 XIRR（小数形式，如 0.1234 = 12.34%），null 表示数据不足 */
  cumulativeXirr: number | null;
  /** 总收益率 = (最新累计净值 - 1) * 100%，null 表示无净值数据 */
  totalReturnRate: number | null;
  /** 当年收益率 = (最新当年净值 - 1) * 100%，null 表示无数据 */
  yearReturnRate: number | null;
  /** 最大回撤（P1，v1 返回 null） */
  maxDrawdown: number | null;
  /** 最新有数据的日期 YYYY-MM-DD */
  latestDate: string;
  /** 成立日 YYYY-MM-DD */
  inceptionDate: string;
}
