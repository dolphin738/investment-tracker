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

export interface LoginResponse {
  accessToken: string;
  user: UserPublic;
}

export type UserProfile = UserPublic;

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
export interface CreateTransactionRequest {
  date: string;
  type: 'BUY' | 'SELL';
  amount: string;
  note?: string;
}

export interface UpdateTransactionRequest {
  date?: string;
  type?: 'BUY' | 'SELL';
  amount?: string;
  note?: string;
}

export type TransactionResponse = Transaction;

export interface TransactionQuery {
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
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
