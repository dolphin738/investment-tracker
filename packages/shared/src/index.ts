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

// 标的类型（Q-3 乙）：唯一定义于 types/security.ts，前后端共用。
// as const 对象 + 同名派生类型，一次 export 同时导出「值」与「类型」两种含义：
// - 后端 holding.controller 用其做 types 查询参数的白名单校验
// - 前端 api/types.ts re-export 后供表单/筛选渲染选项
export { SecurityType } from './types/security.ts';

// ── 概览数据新鲜度（DASH-P1-03 / AL-015）──
// FreshnessKind 既是值（as const 对象）又是类型：前端 banner 用其判定跳转目标。
// 🔴 判定全部在后端完成，前端只渲染 —— 禁止用 latestDate（快照日期）二次判定。
export { FreshnessKind } from './types/overview.ts';
export type { FreshnessInfo, FreshnessReason } from './types/overview.ts';

// ── CSV 导入 / 导出契约（AL-042 / AL-079 / AL-080，T05 实现）──
// ExportType / ImportType / ImportErrorCode 同为「值 + 类型」双重身份。
export {
  ExportType,
  EXPORT_TYPES,
  ImportType,
  IMPORT_TYPES,
  ImportErrorCode,
} from './types/data-transfer.ts';
export type {
  ImportRow,
  ImportRowError,
  ImportPreviewResult,
  ImportCommitResult,
  RecalcSummary,
} from './types/data-transfer.ts';

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
