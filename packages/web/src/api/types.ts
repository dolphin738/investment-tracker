/**
 * api/types.ts — API 请求/响应类型（Web 端本地定义）
 *
 * 此文件定义所有 Web 端使用的 API 请求/响应类型。
 * shared 包中已存在的类型（CashFlow, SecurityTrade, AssetSnapshot 等）从 @investment-tracker/shared import。
 * shared 包中不存在的 UI 辅助类型（UserPublic, Security, HoldingResponse 等）在此本地定义。
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
} from '@investment-tracker/shared';

// ============================================================================
// 本地枚举（shared 包中不存在的 UI 层枚举）
// ============================================================================

/** 标的产品类型 */
export enum SecurityType {
  STOCK = 'STOCK',
  FUND = 'FUND',
  BOND = 'BOND',
  CASH = 'CASH',
  OTHER = 'OTHER',
}

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

/** 净值指标切换 */
export enum NavMetric {
  CUMULATIVE = 'cumulative',
  YEAR = 'year',
  BOTH = 'both',
}

// ============================================================================
// 用户相关
// ============================================================================

/** 用户公开信息（Web 端展示用） */
export interface UserPublic {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  phone: string | null;
  bio: string | null;
  createdAt: string;
  updatedAt: string;
}

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
// 分红/费用相关
// ============================================================================

/** 分红记录 */
export interface DividendRecord {
  id: string;
  portfolioId: string;
  securityId: string;
  date: string;
  type: DividendType;
  amount: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建分红 DTO */
export interface CreateDividendRecordDto {
  securityId: string;
  date: string;
  type: DividendType;
  amount: string;
  note?: string;
}

/** 费用记录 */
export interface FeeRecord {
  id: string;
  portfolioId: string;
  securityId: string;
  date: string;
  type: FeeType;
  amount: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建费用 DTO */
export interface CreateFeeRecordDto {
  securityId: string;
  date: string;
  type: FeeType;
  amount: string;
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
}

export interface TransactionQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  type?: 'BUY' | 'SELL';
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

export type SnapshotResponse = AssetSnapshot;

export interface SnapshotQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  source?: string;
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
  cumulativeNav: number;
  yearNav: number;
  xirr: number | null;
  netInvested: string;
  totalReturnRate: number;
  yearReturnRate: number;
  latestDate: string;
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

/** 组合摘要（用于账户页资产全景、overview API） */
export interface PortfolioSummary {
  id: string;
  name: string;
  totalAsset: string;
  cumulativeNav: number | null;
  cumulativeReturnRate: number | null;
  yearReturnRate: number | null;
  xirr: number | null;
  latestDate: string | null;
}

// ============================================================================
// Account API
// ============================================================================

export interface AccountStats {
  portfolioCount: number;
  transactionCount: number;
  snapshotDays: number;
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
