/**
 * api/types.ts — API 请求/响应类型
 *
 * 复用 shared 包的核心类型，扩展请求 DTO 类型。
 */

import type {
  AssetSnapshot,
  Portfolio,
  Transaction,
  UserPublic,
} from '@investment-tracker/shared';
import type {
  AggregationMethod,
  NavMetric,
  QueryGranularity,
} from '@investment-tracker/shared';

// ===== Auth =====
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

/** 修改密码请求（confirmPassword 仅前端校验，不发送给后端） */
export interface UpdatePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** 修改邮箱请求 */
export interface UpdateEmailRequest {
  currentPassword: string;
  newEmail: string;
}

/** 修改个人资料请求：字段缺省=不修改，null/'' =清空 */
export interface UpdateProfileRequest {
  name?: string | null;
  avatar?: string | null;
  phone?: string | null;
  bio?: string | null;
}

// ===== Upload =====
/** 头像上传响应：新地址 + 已写库的最新用户信息 */
export interface UploadAvatarResponse {
  /** 站内相对路径，如 /api/uploads/avatar/<uuid>.png */
  url: string;
  /** 更新后的用户公开信息（avatar 已指向 url） */
  user: UserPublic;
}

// ===== Portfolio =====
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

// ===== Transaction =====
/** 创建交易请求（扩展：新增 securityId/quantity/price/fee 可选字段） */
export interface CreateTransactionRequest {
  date: string;
  type: 'BUY' | 'SELL';
  amount: string;
  /** 🆕 关联标的 ID（可选） */
  securityId?: string;
  /** 🆕 交易数量（可选） */
  quantity?: string;
  /** 🆕 成交单价（可选） */
  price?: string;
  /** 🆕 手续费（可选） */
  fee?: string;
  note?: string;
}

/** 更新交易请求（扩展：新增 securityId/quantity/price/fee） */
export interface UpdateTransactionRequest {
  date?: string;
  type?: 'BUY' | 'SELL';
  amount?: string;
  /** 🆕 关联标的 ID（可选，传 null 清空） */
  securityId?: string | null;
  /** 🆕 交易数量（可选，传 null 清空） */
  quantity?: string | null;
  /** 🆕 成交单价（可选，传 null 清空） */
  price?: string | null;
  /** 🆕 手续费（可选，传 null 清空） */
  fee?: string | null;
  note?: string | null;
}

/** 🆕 扩展交易响应（后端返回含 securityName） */
export interface TransactionResponse {
  id: string;
  portfolioId: string;
  date: string;
  type: 'BUY' | 'SELL';
  amount: string;
  /** 🆕 关联标的 ID */
  securityId: string | null;
  /** 🆕 标的名称（后端关联查询返回） */
  securityName: string | null;
  /** 🆕 交易数量 */
  quantity: string | null;
  /** 🆕 成交单价 */
  price: string | null;
  /** 🆕 手续费 */
  fee: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 🆕 扩展交易查询参数 */
export interface TransactionQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  /** 🆕 交易类型筛选 */
  type?: 'BUY' | 'SELL';
  /** 🆕 标的 ID 筛选 */
  securityId?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ===== Snapshot =====
export interface UpsertSnapshotRequest {
  date: string;
  totalAsset: string;
  note?: string;
}

export type SnapshotResponse = AssetSnapshot;

export interface SnapshotQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

// ===== Query (XIRR / Nav) =====
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

// ===== Overview =====
export interface OverviewResponse {
  totalAsset: string;
  cumulativeNav: number;
  yearNav: number;
  xirr: number | null;
  netInvested: string;
  totalReturnRate: number;
  yearReturnRate: number;
  latestDate: string;
}

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

// ===== Holding =====
import type { HoldingResponse, HoldingsAggregate, UpsertHoldingDto, Holding } from '@investment-tracker/shared';
export type { HoldingResponse, HoldingsAggregate, UpsertHoldingDto, Holding };

export interface HoldingsListResponse {
  items: HoldingResponse[];
  aggregate: HoldingsAggregate;
}

// ===== Securities =====
import type { Security, CreateSecurityDto, UpdateSecurityDto } from '@investment-tracker/shared';
export type { Security, CreateSecurityDto, UpdateSecurityDto };

// ===== Dividend =====
import type { DividendRecord, CreateDividendRecordDto, DividendType } from '@investment-tracker/shared';
export type { DividendRecord, CreateDividendRecordDto, DividendType };

// ===== Fee =====
import type { FeeRecord, CreateFeeRecordDto, FeeType } from '@investment-tracker/shared';
export type { FeeRecord, CreateFeeRecordDto, FeeType };

// ===== Preference =====
import type { UserPreference, UpdatePreferenceDto } from '@investment-tracker/shared';
export type { UserPreference, UpdatePreferenceDto };

// ===== Account =====
export interface AccountStats {
  portfolioCount: number;
  transactionCount: number;
  snapshotDays: number;
  recordDays: number;
  firstDate: string | null;
  lastDate: string | null;
}
