/**
 * api/types.ts — API 请求/响应类型（Web 端本地定义）
 *
 * 此文件定义所有 Web 端使用的 API 请求/响应类型。
 * shared 包中已存在的类型（CashFlow, SecurityTrade, AssetSnapshot, UserPublic, NavMetric 等）
 * 从 @investment-tracker/shared import 并 re-export，仅 shared 中不存在的 UI 辅助类型
 * （Security, HoldingResponse 等）在此本地定义。
 */

import type {
  AssetSnapshot,
  Portfolio,
  CashFlow,
  SnapshotSource,
  SnapshotValuation,
  AggregationMethod,
  QueryGranularity,
  SecuritySide,
  UserPublic,
  NavMetric,
  FreshnessInfo,
  ImportRow,
  ImportRowError,
  ImportPreviewResult,
  ImportCommitResult,
  RecalcSummary,
} from '@investment-tracker/shared';
// SecurityType 唯一定义在 shared（as const 对象 + 同名类型），此处按值 import 供本文件类型标注使用
import { SecurityType } from '@investment-tracker/shared';
// CSV 导入 / 导出类别与错误码（shared 中同为「值 + 类型」双重身份），按值 re-export 供表单 / 下拉使用
import { ExportType, ImportType, ImportErrorCode } from '@investment-tracker/shared';

// NavMetric 既是值（as const 对象）又是类型（字符串联合），需 re-export 供消费处按值/类型分别 import
export { NavMetric } from '@investment-tracker/shared';
// UserPublic 已在 shared 定义，re-export 供全项目统一引用
export type { UserPublic } from '@investment-tracker/shared';
// SecurityType 同样既是值又是类型；re-export 保持 `@/api/types` 旧引用点可用（前后端共用同一定义，Q-3）
export { SecurityType } from '@investment-tracker/shared';

// ── 概览数据新鲜度（DASH-P1-03 / AL-015）──
// 后端 OverviewService.buildFreshness 已透出；前端只渲染，不二次判定。
export type { FreshnessInfo } from '@investment-tracker/shared';

// ── CSV 导入 / 导出契约（AL-042 / AL-079 / AL-080，T05 实现，T01 落契约）──
export {
  ExportType,
  ImportType,
  ImportErrorCode,
} from '@investment-tracker/shared';
export type {
  ImportRow,
  ImportRowError,
  ImportPreviewResult,
  ImportCommitResult,
  RecalcSummary,
} from '@investment-tracker/shared';

// ============================================================================
// 本地枚举（shared 包中不存在的 UI 层枚举）
// ============================================================================

/** 分红类型 */
export enum DividendType {
  CASH = 'CASH',
  STOCK_DIVIDEND = 'STOCK_DIVIDEND',
}

/** 费用类型 */
export enum FeeType {
  COMMISSION = 'COMMISSION',
  STAMP_TAX = 'STAMP_TAX',
  OTHER = 'OTHER',
}

// ============================================================================
// 用户相关
// ============================================================================

/** 用户偏好 */
export interface UserPreference {
  id: string;
  userId: string;
  defaultPortfolioId: string | null;
  defaultGranularity: string;
  defaultDateRange: string;
  aggregation: string;
  weekStartsOn: number;
  navDecimals: number;
  xirrDecimals: number;
  theme: string;
  staleDays: number;
  /** 出入金后现金余额软提示开关（SET-P0-07） */
  cashHintOnCashflow: boolean;
  /** 证券买卖后现金余额软提示开关（SET-P0-07） */
  cashHintOnTrade: boolean;
  /** 金额千分位（SET-P1-03） */
  amountThousands: boolean;
  /** 金额万 / 亿缩写（SET-P1-03） */
  amountAbbrev: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 更新偏好 DTO */
export interface UpdatePreferenceDto {
  defaultPortfolioId?: string | null;
  defaultGranularity?: string;
  defaultDateRange?: string;
  aggregation?: string;
  weekStartsOn?: number;
  navDecimals?: number;
  xirrDecimals?: number;
  theme?: string;
  staleDays?: number;
  cashHintOnCashflow?: boolean;
  cashHintOnTrade?: boolean;
  amountThousands?: boolean;
  amountAbbrev?: boolean;
}

// ============================================================================
// 标的相关
// ============================================================================

/** 证券标的 */
export interface Security {
  id: string;
  portfolioId: string;
  code: string;
  name: string;
  type: SecurityType;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建标的 DTO */
export interface CreateSecurityDto {
  code: string;
  name: string;
  type: SecurityType;
  note?: string;
}

/** 更新标的 DTO */
export interface UpdateSecurityDto {
  code?: string;
  name?: string;
  type?: SecurityType;
  note?: string | null;
}

// ============================================================================
// 持仓相关（方案B: 由 SecurityTrade 推导，只读）
// ============================================================================

/**
 * 持仓响应（方案B 后端实时推导返回，对齐 HoldingDerivationService.HoldingView）
 *
 * 数值字段为 number（后端推导计算直接返回，非 Decimal 字符串）。
 */
export interface HoldingResponse {
  /** 标的 ID */
  securityId: string;
  /** 标的代码 */
  securityCode: string;
  /** 标的名称 */
  securityName: string;
  /** 标的类型 */
  securityType: string;
  /** 持仓数量 */
  quantity: number;
  /** 移动加权平均成本价 */
  avgCost: number;
  /** 成本总额 */
  costTotal: number;
  /** 现价（向前沿用） */
  marketPrice: number;
  /** 现价日期 YYYY-MM-DD，null = 无价格记录（回退成本估值） */
  priceAsOf: string | null;
  /** 持仓市值 = quantity * marketPrice */
  marketValue: number;
  /** 浮动盈亏 */
  pnl: number;
  /** 盈亏率 */
  pnlRate: number;
  /** 估值标识：EXACT（有现价）/ COST_BASED（回退成本） */
  flag: 'EXACT' | 'COST_BASED';
}

/** 持仓汇总 */
export interface HoldingsAggregate {
  totalMarketValue: number;
  totalCost: number;
  totalProfit: number;
  totalProfitRate: number;
  securityCount: number;
}

// ============================================================================
// 分红/费用相关（HOLD-B-P0-10 · 不参与 XIRR/净值计算 D-02/D-03）
//
// ⚠️ 与后端 DividendService/FeeService 响应逐字段对齐：
// - 两表**无 updatedAt 列**（schema.prisma:230/247 只有 createdAt），故此处不得声明
// - 后端 include security 后回填 securityName / securityCode，前端无需再映射
// - amount 为 NUMERIC(18,2) 字符串，避免 JS 浮点丢精，展示前用 Number() 转换
// ============================================================================

/** 分红记录 */
export interface DividendRecord {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  type: DividendType;
  amount: string;
  note: string | null;
  createdAt: string;
}

/** 创建分红 DTO（type 可选，后端缺省 CASH） */
export interface CreateDividendRecordDto {
  securityId: string;
  date: string;
  type?: DividendType;
  amount: string;
  note?: string;
}

/** 费用记录 */
export interface FeeRecord {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  type: FeeType;
  amount: string;
  /** 关联证券买卖流水 ID（可选） */
  transactionId: string | null;
  note: string | null;
  createdAt: string;
}

/** 创建费用 DTO（type 可选，后端缺省 OTHER） */
export interface CreateFeeRecordDto {
  securityId: string;
  date: string;
  type?: FeeType;
  amount: string;
  transactionId?: string;
  note?: string;
}

// ============================================================================
// Auth API
// ============================================================================

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

/** 登录 / 改密码 / 改邮箱 统一返回：新 token + 最新用户信息 */
export interface AuthTokenResponse {
  accessToken: string;
  user: UserPublic;
}

export type LoginResponse = AuthTokenResponse;

/**
 * 注销账户自助恢复请求（SYS-P1-02）
 *
 * 对应 POST /api/auth/account/restore（免 JWT），复用登录页已填的邮箱 + 密码。
 * 成功响应与登录一致（LoginResponse），前端可直接进入登录态。
 */
export interface RestoreRequest {
  email: string;
  password: string;
}

export type UserProfile = UserPublic;

/** 修改密码请求 */
export interface UpdatePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** 修改邮箱请求 */
export interface UpdateEmailRequest {
  currentPassword: string;
  newEmail: string;
}

/** 修改个人资料请求 */
export interface UpdateProfileRequest {
  name?: string | null;
  avatar?: string | null;
  phone?: string | null;
  bio?: string | null;
}

// ============================================================================
// Upload API
// ============================================================================

export interface UploadAvatarResponse {
  url: string;
  user: UserPublic;
}

// ============================================================================
// Portfolio API
// ============================================================================

export interface CreatePortfolioRequest {
  name: string;
  description?: string;
  currency?: string;
}

export interface UpdatePortfolioRequest {
  name?: string;
  description?: string;
}

export type PortfolioResponse = Portfolio;

// ============================================================================
// Transaction (CashFlow) API — 出入金
// ============================================================================

export interface CreateTransactionRequest {
  date: string;
  type: 'BUY' | 'SELL';
  amount: string;
  securityId?: string;
  quantity?: string;
  price?: string;
  fee?: string;
  note?: string;
}

export interface UpdateTransactionRequest {
  date?: string;
  type?: 'BUY' | 'SELL';
  amount?: string;
  securityId?: string | null;
  quantity?: string | null;
  price?: string | null;
  fee?: string | null;
  note?: string | null;
}

/**
 * 重算反馈（FLOW-P0-04 / CASH-P0-03；Part E-6 字段命名）。
 *
 * F3 获批后由后端 cashflow create/update/remove 响应并入；字段缺失即 undefined，
 * 前端 toast 据此做兜底降级（见 use-transactions.buildRecalcSuffix）。
 * - fromDate / affectedDays：F3 后端返回（recalculateRange 已有，透出即可）
 * - updatedAutoDays / skippedManualDays：F4 后端返回（手工跳过统计），缺失时前端省略提示
 */
export interface RecalculationInfo {
  /** 重算起始日 YYYY-MM-DD（自该日起净值/XIRR 被批量重算） */
  fromDate: string;
  /** 受影响天数 N */
  affectedDays: number;
  /** 被重写的自动总资产记录条数 M（F4；缺失时不展示） */
  updatedAutoDays?: number;
  /** 手工记录被跳过的天数 Z（F4；缺失时不展示） */
  skippedManualDays?: number;
}

/** 出入金响应（含扩展字段） */
export interface TransactionResponse {
  id: string;
  portfolioId: string;
  date: string;
  type: 'BUY' | 'SELL';
  amount: string;
  securityId: string | null;
  securityName: string | null;
  quantity: string | null;
  price: string | null;
  fee: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** 重算反馈（F3/F4 后端返回；缺失即 undefined，前端兜底近似） */
  recalculation?: RecalculationInfo;
}

/** 删除出入金响应（F3：后端返回 { recalculation }；旧后端仍返回 null 时前端兜底） */
export interface TransactionDeleteResponse {
  recalculation?: RecalculationInfo;
}

export interface TransactionQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  /** 分页大小（FLOW-P0-02 验收2：20 / 50 / 100，默认 20） */
  pageSize?: number;
  /**
   * 类型多选（F2 已获批，Part E-1 语义）：
   * - 空数组 / 不传 = 全部（与「重置」一致，避免歧义）
   * - 勾选一个 = 仅该类；勾选两个 = 全部（等价不传）
   * 传输形式：URL query `types=BUY,SELL`（逗号分隔，listTransactions 内 join 后透传，
   * 避免 axios 默认 `types[]=...` 序列化触发后端 forbidNonWhitelisted 400）。
   */
  types?: Array<'BUY' | 'SELL'>;
  /** 排序字段（F5 已获批）：date | amount；缺省后端按 date desc */
  sortBy?: 'date' | 'amount';
  /** 排序方向（F5 已获批）：asc | desc */
  sortOrder?: 'asc' | 'desc';
  securityId?: string;
}

/** 通用分页响应 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============================================================================
// Snapshot API
// ============================================================================

export interface UpsertSnapshotRequest {
  date: string;
  totalAsset: string;
  /** 拆解：持仓市值合计（可选） */
  marketValue?: string;
  /** 拆解：当日现金余额（可选） */
  cashBalance?: string;
  note?: string;
}

/**
 * 快照列表/保存响应。
 *
 * `derivedTotalAsset`：该日**系统自动计算值**（Decimal 字符串），由后端
 * `SnapshotService` 实时回填（AL-054 / 决策 Q-1 甲）：
 * - `source === 'DERIVED'` → 等于 `totalAsset`（不重复计算）；
 * - `source === 'MANUAL'`  → `computeDerived(date)` 的实时结果；
 * - 计算失败 / 数据缺失     → `null`（列表仍返回 200）。
 * 运行时计算字段，不落库（Prisma schema 零变更）。
 */
export interface SnapshotResponse extends AssetSnapshot {
  /** 该日系统自动计算值（Decimal 字符串）；计算失败 / 数据缺失 → null */
  derivedTotalAsset: string | null;
}

export interface SnapshotQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  /**
   * 来源筛选（DERIVED=自动 / MANUAL=手工）。
   * F2 已获批：后端 list 支持 source 服务端筛选，前端可发送；
   * 后端 DTO 落盘前发送会 400（ValidationPipe forbidNonWhitelisted），联调时注意先后顺序。
   */
  source?: SnapshotSource;
}

// ============================================================================
// Query API (XIRR / NAV)
// ============================================================================

export interface XirrQueryParams {
  granularity?: QueryGranularity;
  startDate?: string;
  endDate?: string;
  aggregation?: AggregationMethod;
}

export interface NavQueryParams {
  granularity?: QueryGranularity;
  startDate?: string;
  endDate?: string;
  aggregation?: AggregationMethod;
  metric?: NavMetric;
}

// ============================================================================
// Overview API
// ============================================================================

export interface OverviewResponse {
  totalAsset: string;
  /** 累计净值（后端 toFixed(6) 字符串） */
  cumulativeNav: string;
  /** 当年净值（后端 toFixed(6) 字符串） */
  yearNav: string;
  /** 年化 XIRR（后端 toString 字符串）；null = 数据不足 */
  xirr: string | null;
  netInvested: string;
  /** 累计收益率（后端 toFixed(8) 字符串，比率非百分数） */
  totalReturnRate: string;
  /** 当年收益率（后端 toFixed(8) 字符串，比率非百分数） */
  yearReturnRate: string;
  latestDate: string;
  /**
   * 最新总资产快照来源（Q-2 乙 · 后端 overview.service 已透出）：
   * 'MANUAL' = 手工录入（概览页展示「✋手工」徽标）/ 'DERIVED' = 系统派生 / null = 尚无快照。
   *
   * 声明为可选：兼容尚未升级的后端（运行时 undefined），前端一律用 `=== 'MANUAL'` 判定。
   */
  latestSource?: SnapshotSource | null;
  /**
   * 数据新鲜度（PRD DASH-P1-03 / AL-015 · 决策 O-6）。
   * 后端判定（阈值 / 滞后天数 / 文案），前端只渲染。口径＝行情 / 现金 asOf 滞后，非 latestDate。
   *
   * 声明为可选：兼容尚未升级的后端（运行时 undefined），前端一律判空后渲染；
   * 已升级后端必然返回（见 backend OverviewService.buildFreshness）。
   */
  freshness?: FreshnessInfo;
  /** 持仓汇总（后端 OverviewService 返回） */
  holdingsSummary: {
    totalMarketValue: string;
    totalCost: string;
    totalProfit: string;
    securityCount: number;
  };
  /** 最近 5 笔出入金 */
  recentTransactions: Array<{
    id: string;
    date: string;
    type: string;
    amount: string;
    note: string | null;
  }>;
}

/**
 * 组合摘要（GET /portfolios/summary · 用于账户页资产全景 / 组合列表）
 *
 * 数值字段一律以 string 跨网（Prisma.Decimal.toFixed(n)）：
 * - 金额 2 位（totalAsset / netInvested / floatingProfit）
 * - 净值 6 位（cumulativeNav）
 * - 收益率 8 位（yearReturnRate，**比率**非百分数，前端 formatPercent 内部 ×100）
 * - 「无数据」一律 null（cumulativeNav / yearReturnRate / floatingProfit / baseDate），
 *   前端渲染「—」或「未成立」，禁止把 null 渲染成 0（SYS-P0-05 四态）。
 */
export interface PortfolioSummary {
  id: string;
  name: string;
  /** 最新一条总资产快照金额；无快照时后端返回 '0' */
  totalAsset: string;
  /** 持仓标的数 */
  holdingsCount: number;
  /** 最近更新日 YYYY-MM-DD（取快照/买卖较晚者） */
  lastUpdatedAt: string | null;
  /** 组合成立日 = 首笔存入日（FIN-D6）YYYY-MM-DD；null = 尚无存入，组合未成立 */
  baseDate: string | null;
  /** 组合币种（v1 恒为 CNY） */
  currency: string;
  /** 组合创建时间 ISO 8601（baseDate 为 null 时前端展示「创建于 …」） */
  createdAt: string;
  /** 最新累计净值，6 位小数字符串；null = 尚无 DailyNav */
  cumulativeNav: string | null;
  /** 当年收益率（比率，非百分数）= yearNav - 1，8 位小数字符串；null = 尚无 DailyNav */
  yearReturnRate: string | null;
  /**
   * 累计收益率（**比率**，非百分数）= cumulativeNav - 1，后端 toFixed(8) 字符串。
   *
   * Q-4 甲 已由后端 /portfolios/summary 返回；null = 尚无 DailyNav。
   * 仍标为可选以兼容尚未升级的后端（运行时 undefined），消费端保持 `!= null` 判空。
   */
  cumulativeReturnRate?: string | null;
  /**
   * 年化收益率 XIRR（**比率**，非百分数），后端 toFixed(8) 字符串。
   *
   * Q-4 甲 已由后端 /portfolios/summary 返回；null = 尚无 DailyXirr 或数据不足。
   * 仍标为可选以兼容尚未升级的后端（运行时 undefined），消费端保持 `!= null` 判空。
   */
  xirr?: string | null;
  /** 净投入 = Σ存入 - Σ取出，2 位小数字符串（必填；无出入金为 '0.00'） */
  netInvested: string;
  /** 浮动盈亏 = totalAsset - netInvested，2 位小数字符串；null = 无总资产记录 */
  floatingProfit: string | null;
}

// ============================================================================
// Account API
// ============================================================================

/**
 * 账户统计（GET /account/stats · 账户页数据统计卡 ACC-P0-06）
 */
export interface AccountStats {
  portfolioCount: number;
  /** 出入金笔数（CashFlow 计数） */
  cashflowCount: number;
  /** 证券买卖笔数（SecurityTrade 计数） */
  tradeCount: number;
  /** 总资产记录天数（跨组合去重） */
  snapshotDays: number;
  /** 账户使用天数（注册至今） */
  recordDays: number;
  firstDate: string | null;
  lastDate: string | null;
}

// ============================================================================
// Security Trade API — 证券买卖流水（方案B · 持仓推导唯一来源）
// ============================================================================

/**
 * 证券买卖流水响应（后端 Decimal 以 string 传输，与 shared SecurityTrade 一致）
 */
export interface SecurityTradeResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  date: string;
  /** BUY_SEC=买入 / SELL_SEC=卖出 */
  side: SecuritySide;
  quantity: string;
  price: string;
  fee: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建证券买卖流水 DTO（数量/单价/费用为 number，后端 DTO 要求 IsNumber） */
export interface CreateSecurityTradeRequest {
  securityId: string;
  date: string;
  side: SecuritySide;
  quantity: number;
  price: number;
  fee: number;
  note?: string;
}

/** 更新证券买卖流水 DTO（全部可选） */
export interface UpdateSecurityTradeRequest {
  securityId?: string;
  date?: string;
  side?: SecuritySide;
  quantity?: number;
  price?: number;
  fee?: number;
  note?: string | null;
}

/** 证券买卖流水查询参数 */
export interface SecurityTradeQuery {
  startDate?: string;
  endDate?: string;
  securityId?: string;
  side?: SecuritySide;
  page?: number;
  pageSize?: number;
}

// ============================================================================
// Security Price API — 标的最新价（向前沿用）
// ============================================================================

/** 标的最新价响应 */
export interface SecurityPriceResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  price: string;
  asOf: string;
  createdAt: string;
}

/** 录入/覆盖标的最新价 DTO */
export interface UpsertSecurityPriceRequest {
  securityId: string;
  asOf: string;
  price: number;
}

/** 价格查询参数 */
export interface SecurityPriceQuery {
  securityId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

// ============================================================================
// Cash Balance API — 现金余额（手工维护 · 前向沿用）
// ============================================================================

/** 现金余额响应 */
export interface CashBalanceResponse {
  id: string;
  portfolioId: string;
  amount: string;
  asOf: string;
  note: string | null;
  createdAt: string;
}

/** 录入/覆盖现金余额 DTO */
export interface UpsertCashBalanceRequest {
  asOf: string;
  amount: number;
  note?: string;
}

/** 现金余额查询参数 */
export interface CashBalanceQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}
