/**
 * @investment-tracker/shared — 统一导出入口
 *
 * 三端（backend / web / harmonyos）共用的类型、枚举与 API 契约。
 */

// ── 枚举 ──
export {
  CashFlowType,
  SecuritySide,
  SnapshotSource,
  SnapshotValuation,
  QueryGranularity,
  AggregationMethod,
} from './enums';

// ── 核心类型 ──
export type {
  CashFlow,
  SecurityTrade,
  SecurityPrice,
  CashBalance,
  Portfolio,
  AssetSnapshot,
  DailyNav,
  DailyXirr,
  NavSeriesPoint,
  XirrSeriesPoint,
  PortfolioSummary,
} from './types';

// ── API 契约 ──
export type {
  ApiResponse,
  PaginationQuery,
  Paginated,
  DateRangeQuery,
} from './api-contracts';
