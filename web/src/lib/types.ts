/**
 * web/src/lib/types.ts — 前端契约聚合层（§5.2 退役后的唯一类型真相源）
 *
 * 退役背景：原 `web/src/shared/index.ts` 是从参考源 `app/` 逐字复制的「本地垫片」，
 * 经 `@/lib/types` 别名被 ~60 处引用。它本是临时起步副本，却长期
 * 充当事实真相源，存在「后端改字段/枚举、OpenAPI 生成 `types/api.ts` 更新、手写
 * 垫片却不同步」的双真相源漂移风险。§5.2 退役将其收敛到本文（明确的聚合层），
 * `shared/index.ts` 仅保留为转发 barrel，最终别名也会被移除。
 *
 * 本文件内容分类（退役关键决策 + §5.2b 收敛后现状）：
 * 1. 实体类型：`CashFlow` / `Portfolio` / `AssetSnapshot` 已改为
 *    `components['schemas']['XxxOut']` 的 **re-export 别名**（§5.2b：P1 补齐后端缺字段、
 *    P2 枚举独立 schema 后，DTO 字段与前端视图模型已 1:1 对齐，可安全重导出）。
 *    `UserPublic` 因后端 `UserPublicOut` 把 `createdAt` 声明为可选、且 `name` 非空，
 *    与前端 `createdAt: string` / `name: string|null` 方向相反，**保留手写**（残留项）。
 *    金额字段一律 string 透传（Decimal→str 铁律，C-02）。
 * 2. 枚举 / 业务错误码 / 金额工具（`CashFlowType` / `SecuritySide` / `BUSINESS_ERROR_CODE`
 *    / `isMoneyString` / `computeNetAmount` / ...）= 前后端约定常量。后端 6 领域枚举 +
 *    `ExportType`/`ImportType`/`ImportErrorCode` 已由 P2 提升为独立命名 schema
 *    （`types/api.ts` 生成 `components['schemas']['Xxx']` 联合类型）；枚举的**运行时
 *    `as const` 对象**仍留本文件（下拉遍历需要值），与生成类型值一致。
 * 3. `NavSeriesPoint` / `XirrSeriesPoint` = **number 版展示类型**（图表/ECharts 只认
 *    number），移入 `types/series.ts`，本文件 re-export 维持历史 import 点。后端返回
 *    string（`NavPointOut`/`XirrPointOut`），由 `api/query.api.ts` 在取数边界用
 *    `toNumberOrNull`（策略 A）统一转换产出。
 *
 * 同步约定：后端改实体/枚举后，先 `npm run generate:api` 更新 `types/api.ts`，
 * 再确认本文件 re-export 别名与新增命名字段/枚举是否同步——这是退役后唯一的同步点。
 */

import type { components } from '@/types/api';

// ============================================================================
// 金额 / 税 / 费用工具（前后端共用，零依赖）
// 来源：app/packages/shared/src/money.ts
// ============================================================================

/** 金额正则：非负、最多 2 位小数（空串不匹配） */
export const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** isMoneyString 选项 */
export interface MoneyOptions {
  /**
   * 是否允许 0（默认 true：'0' / '0.00' 合法，税与费用允许为 0）。
   * 置 false 时要求数值 > 0（分红金额 / 费用金额这类必须为正的字段）。
   */
  allowZero?: boolean;
}

/**
 * 校验字符串是否为合法金额（非负、最多 2 位小数）。
 */
export function isMoneyString(value: string, opts: MoneyOptions = {}): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!MONEY_RE.test(v)) return false;
  if (opts.allowZero === false) {
    return Number(v) > 0;
  }
  return true;
}

/** 金额字符串 → 整数分（BigInt，精确无浮点） */
function toCents(value: string): bigint {
  const v = value.trim();
  if (v === '' || v === '.') return 0n;
  const [intPart = '0', fracPart = ''] = v.split('.');
  const frac = (fracPart + '00').slice(0, 2);
  return BigInt(intPart || '0') * 100n + BigInt(frac || '0');
}

/** 整数分 → 金额字符串（恒 2 位小数） */
function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const int = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${int.toString()}.${frac.toString().padStart(2, '0')}`;
}

/**
 * 计算净额 = amount − tax（整数分运算，返回恒 2 位小数字符串）。
 */
export function computeNetAmount(amount: string, tax: string): string {
  return fromCents(toCents(amount) - toCents(tax));
}

/**
 * 金额求和（整数分运算，返回恒 2 位小数字符串）。
 */
export function sumMoney(values: Array<string | number>): string {
  let total = 0n;
  for (const v of values) {
    total += toCents(String(v));
  }
  return fromCents(total);
}

// ============================================================================
// 边界数值转换（策略 A · §5.2 退役）
// 后端 Decimal 以 string 传输（C-02 铁律），图表/ECharts 只认 number。
// 在取数边界（api/query.api.ts）统一 string→number 一次，消除散落的 Number()。
// ============================================================================

/** 后端 string 数值 → 前端 number（null 安全；非有限数返回 null） */
export function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// 共享枚举定义
// 来源：app/packages/shared/src/enums.ts
// ============================================================================

/** 出入金流水类型：BUY=存入（现金流为负），SELL=取出（现金流为正） */
export const CashFlowType = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;
export type CashFlowType = typeof CashFlowType[keyof typeof CashFlowType];

/** 证券买卖方向（严禁复用 CashFlowType，C-10） */
export const SecuritySide = {
  BUY_SEC: 'BUY_SEC',
  SELL_SEC: 'SELL_SEC',
} as const;
export type SecuritySide = typeof SecuritySide[keyof typeof SecuritySide];

/** 资产快照来源：DERIVED=系统自动派生，MANUAL=用户手工录入 */
export const SnapshotSource = {
  DERIVED: 'DERIVED',
  MANUAL: 'MANUAL',
} as const;
export type SnapshotSource = typeof SnapshotSource[keyof typeof SnapshotSource];

/** 资产快照估值方式标识 */
export const SnapshotValuation = {
  EXACT: 'EXACT',
  CARRIED_FORWARD: 'CARRIED_FORWARD',
  COST_BASED: 'COST_BASED',
  MANUAL_INPUT: 'MANUAL_INPUT',
} as const;
export type SnapshotValuation =
  typeof SnapshotValuation[keyof typeof SnapshotValuation];

/** 查询时间粒度 */
export const QueryGranularity = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
} as const;
export type QueryGranularity =
  typeof QueryGranularity[keyof typeof QueryGranularity];

/** 聚合方式：last=取期末值，avg=取区间均值 */
export const AggregationMethod = {
  LAST: 'last',
  AVG: 'avg',
} as const;
export type AggregationMethod =
  typeof AggregationMethod[keyof typeof AggregationMethod];

// ============================================================================
// 查询指标枚举（净值）
// 来源：app/packages/shared/src/types/query.ts
// ============================================================================

/** 净值查询的指标选择 */
export const NavMetric = {
  CUMULATIVE: 'cumulative',
  YEAR: 'year',
  BOTH: 'both',
} as const;
export type NavMetric = typeof NavMetric[keyof typeof NavMetric];

// ============================================================================
// 标的类型常量（值对象）
// 来源：app/packages/shared/src/types/security.ts
// ============================================================================

export const SecurityType = {
  STOCK: 'STOCK',
  FUND: 'FUND',
  BOND: 'BOND',
  CASH: 'CASH',
  OTHER: 'OTHER',
} as const;
export type SecurityType = (typeof SecurityType)[keyof typeof SecurityType];

// ============================================================================
// 概览数据新鲜度（DASH-P1-03 / AL-015）
// 来源：app/packages/shared/src/types/overview.ts
// ============================================================================

/** 新鲜度提示的来源类别 */
export const FreshnessKind = {
  PRICE: 'PRICE',
  CASH: 'CASH',
} as const;
export type FreshnessKind = (typeof FreshnessKind)[keyof typeof FreshnessKind];

/** 单条「数据不新鲜」的原因 */
export interface FreshnessReason {
  kind: FreshnessKind;
  asOf: string | null;
  lagDays: number | null;
  label: string;
}

/** 数据新鲜度聚合信息 */
export interface FreshnessInfo {
  staleDays: number;
  isStale: boolean;
  latestPriceAsOf: string | null;
  latestPriceLagDays: number | null;
  latestCashAsOf: string | null;
  latestCashLagDays: number | null;
  reasons: FreshnessReason[];
}

// ============================================================================
// API 契约类型定义（信封 / 分页 / 日期范围）
// 来源：app/packages/shared/src/api-contracts.ts
// ============================================================================

/** 统一 API 响应信封 */
export interface ApiResponse<T = unknown> {
  code: number;
  data: T | null;
  message: string;
}

/** 分页请求参数 */
export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

/** 分页响应 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 日期范围查询参数 */
export interface DateRangeQuery {
  startDate?: string;
  endDate?: string;
}

// ============================================================================
// 业务错误码 / 账户保留期常量（前后端同源，SYS-P1-02）
// 来源：app/packages/shared/src/types/api.ts
// ============================================================================

/** 成功响应的默认 message */
export const SUCCESS_MESSAGE = 'success';

/** API 成功状态码 */
export const SUCCESS_CODE = 0;

export const BUSINESS_ERROR_CODE = {
  SUCCESS: 0,
  UNAUTHORIZED: 1001,
  TOKEN_EXPIRED: 1002,
  EMAIL_TAKEN: 1003,
  PASSWORD_WRONG: 1004,
  FILE_INVALID: 1006,
  PENDING_DELETION: 1007,
  ACCOUNT_NOT_DELETED: 1008,
  RESTORE_EXPIRED: 1009,
  VALIDATION_FAILED: 2000,
  NOT_FOUND: 3001,
  INTERNAL_ERROR: 5000,
} as const;
export type BusinessErrorCode =
  (typeof BUSINESS_ERROR_CODE)[keyof typeof BUSINESS_ERROR_CODE];

/** 账户注销后的软删除保留期（冷静期）天数 */
export const ACCOUNT_RETENTION_DAYS = 30;
/** 账户注销后的软删除保留期（冷静期）毫秒数 */
export const ACCOUNT_RETENTION_MS = ACCOUNT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 业务码 1007（账户处于注销冷静期）随响应 data 一并返回的结构 */
export interface AccountPendingDeletionData {
  remainingDays: number;
}

// ============================================================================
// Data Transfer（CSV 导入 / 导出）类型定义
// 来源：app/packages/shared/src/types/data-transfer.ts
// ============================================================================

/** 可导出的数据类别（7 类） */
export const ExportType = {
  SECURITIES: 'securities',
  SECURITY_TRADES: 'securityTrades',
  CASH_FLOWS: 'cashFlows',
  CASH_BALANCES: 'cashBalances',
  SECURITY_PRICES: 'securityPrices',
  ASSET_SNAPSHOTS: 'assetSnapshots',
  NAV_SERIES: 'navSeries',
} as const;
export type ExportType = (typeof ExportType)[keyof typeof ExportType];
export const EXPORT_TYPES: readonly ExportType[] = Object.values(ExportType);

/** 可导入的数据类别（3 类） */
export const ImportType = {
  SECURITY_TRADES: 'securityTrades',
  CASH_FLOWS: 'cashFlows',
  ASSET_SNAPSHOTS: 'assetSnapshots',
} as const;
export type ImportType = (typeof ImportType)[keyof typeof ImportType];
export const IMPORT_TYPES: readonly ImportType[] = Object.values(ImportType);

/** 导入错误码 */
export const ImportErrorCode = {
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  TOO_MANY_ROWS: 'TOO_MANY_ROWS',
  MISSING_REQUIRED_COLUMN: 'MISSING_REQUIRED_COLUMN',
  INVALID_DATE_FORMAT: 'INVALID_DATE_FORMAT',
  INVALID_DECIMAL_PRECISION: 'INVALID_DECIMAL_PRECISION',
  INVALID_ENUM_VALUE: 'INVALID_ENUM_VALUE',
  SECURITY_NOT_FOUND: 'SECURITY_NOT_FOUND',
  DUPLICATE_SNAPSHOT_DATE: 'DUPLICATE_SNAPSHOT_DATE',
} as const;
export type ImportErrorCode =
  (typeof ImportErrorCode)[keyof typeof ImportErrorCode];

/** 单元格 / 行级错误 */
export interface ImportRowError {
  row: number;
  field: string | null;
  code: ImportErrorCode;
  message: string;
}

/** CSV 导入行的通用形态 */
export type ImportRow = Record<string, string>;

/** 预览结果（阶段一，**绝不写库**） */
export interface ImportPreviewResult {
  type: ImportType;
  totalRows: number;
  validRows: number;
  sample: ImportRow[];
  errors: ImportRowError[];
  minDate: string | null;
  token: string;
}

/** 单次重算摘要（🔴 全流程仅 1 次） */
export interface RecalcSummary {
  fromDate: string;
  toDate: string;
  recalculatedDays: number;
}

/** 提交结果（阶段二） */
export interface ImportCommitResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: ImportRowError[];
  recalculated: RecalcSummary | null;
}

// ============================================================================
// 核心数据类型（纯数据类型）
// 来源：app/packages/shared/src/types.ts + types/user.ts
// ============================================================================

/** 出入金流水（XIRR 现金流唯一来源）— re-export 自后端 `CashflowOut`（§5.2b 收敛） */
export type CashFlow = components['schemas']['CashflowOut'];

/**
 * 用户公开信息（API 响应中传输的安全子集，不含 passwordHash）。
 * ⚠️ 故意保留手写接口（§5.2b 收敛的**残留项**）：后端 `UserPublicOut` 将 `createdAt`
 * 声明为可选（`string | null`），但前端依赖 `createdAt: string`（user 行恒有 createdAt）；
 * 且 `name` 在后端正为非空 `str` 而前端允许 null。re-export 会把 `createdAt` 拓宽为可空
 * 并破坏严格消费处，故不自 `UserPublicOut` 重导出（字段漂移风险极低，用户模型稳定）。
 */
export interface UserPublic {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  phone: string | null;
  bio: string | null;
  createdAt: string;
}

/** 投资组合 — re-export 自后端 `PortfolioOut`（§5.2b 收敛） */
export type Portfolio = components['schemas']['PortfolioOut'];

/**
 * 总资产每日唯一记录（派生层 + 手工）— re-export 自后端 `SnapshotOut`（§5.2b 收敛）。
 * 注：后端 `SnapshotOut.totalAsset` 为 `string | null`（MANUAL 快照可能无 user 值），
 * 比前端原 `string` 更准确；消费处按可空处理。
 */
export type AssetSnapshot = components['schemas']['SnapshotOut'];

// NavSeriesPoint / XirrSeriesPoint 是 number 视图类型（图表/ECharts 只认 number），
// 不属契约常量，移入 types/series.ts（§5.2b）。此处 re-export 维持历史 import 点不变。
export type { NavSeriesPoint, XirrSeriesPoint } from '@/types/series';
