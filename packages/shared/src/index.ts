/**
 * @investment-tracker/shared — 统一导出入口
 *
 * 两端（backend / web）共用的类型、枚举与 API 契约。
 */

// ── 枚举 ──
export {
  CashFlowType,
  SecuritySide,
  SnapshotSource,
  SnapshotValuation,
  QueryGranularity,
  AggregationMethod,
} from './enums.ts';

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
} from './types.ts';

// 用户公开信息定义于 types/user.ts（与 types.ts 文件分离），单独 re-export
export type { UserPublic } from './types/user.ts';

// 查询指标枚举 / 交易类型同样定义于 types/ 目录，单独 re-export
export { NavMetric } from './types/query.ts';
export { TransactionType } from './types/transaction.ts';

// ── API 契约 ──
export type {
  ApiResponse,
  PaginationQuery,
  Paginated,
  DateRangeQuery,
} from './api-contracts.ts';

// ── 业务错误码 / 账户保留期常量（前后端同源，SYS-P1-02）──
// 注意：types/api.ts 里同名的 ApiResponse / Paginated 等不在此 re-export，
// 响应信封契约以上面的 api-contracts.ts 为准，避免重复导出冲突。
export {
  BUSINESS_ERROR_CODE,
  ACCOUNT_RETENTION_DAYS,
  ACCOUNT_RETENTION_MS,
} from './types/api.ts';
export type {
  BusinessErrorCode,
  AccountPendingDeletionData,
} from './types/api.ts';
