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

// 用户公开信息定义于 types/user.ts（与 types.ts 文件分离），单独 re-export
export type { UserPublic } from './types/user';

// 查询指标枚举 / 交易类型同样定义于 types/ 目录，单独 re-export
export { NavMetric } from './types/query';
export { TransactionType } from './types/transaction';

// ── API 契约 ──
export type {
  ApiResponse,
  PaginationQuery,
  Paginated,
  DateRangeQuery,
} from './api-contracts';
