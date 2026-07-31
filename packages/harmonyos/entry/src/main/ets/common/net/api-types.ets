/**
 * API 请求/响应数据类型定义
 *
 * 手动同步 packages/shared/src/types/ 中的类型定义。
 * ArkTS 不支持直接 import TypeScript 包，需在此手动镜像。
 * 字段名、类型、响应格式与 shared 包完全一致。
 */

// ==================== 通用类型 ====================

/**
 * 统一 API 响应信封
 * { code: 0, data: T, message: 'success' }
 */
export interface ApiResponse<T> {
  code: number;
  data: T | null;
  message: string;
}

/**
 * 分页响应结构
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ==================== 枚举常量 ====================

/** 交易类型：BUY=买入（现金流为负），SELL=卖出（现金流为正） */
export enum TransactionType {
  BUY = 'BUY',
  SELL = 'SELL',
}

/** 查询粒度：日/周/月/年 */
export enum QueryGranularity {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
}

/** 聚合方式：last=期末值，avg=均值 */
export enum AggregationMethod {
  LAST = 'last',
  AVG = 'avg',
}

// ==================== 用户类型 ====================

/** 用户公开信息（API 响应中传输，不含密码哈希） */
export interface UserInfo {
  id: string;
  email: string;
  name: string | null;
}

/** 登录响应 */
export interface LoginResponse {
  accessToken: string;
  user: UserInfo;
}

/** 注册请求体 */
export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

/** 登录请求体 */
export interface LoginRequest {
  email: string;
  password: string;
}

// ==================== 组合类型 ====================

/** 投资组合实体 */
export interface Portfolio {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  baseDate: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建组合请求体 */
export interface CreatePortfolioRequest {
  name: string;
  description?: string;
  currency?: string;
}

/** 更新组合请求体 */
export interface UpdatePortfolioRequest {
  name?: string;
  description?: string;
}

// ==================== 交易类型 ====================

/** 交易记录实体 */
export interface Transaction {
  id: string;
  portfolioId: string;
  date: string;
  type: TransactionType;
  amount: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建交易请求体 */
export interface CreateTransactionRequest {
  date: string;
  type: TransactionType;
  amount: string;
  note?: string;
}

/** 更新交易请求体 */
export interface UpdateTransactionRequest {
  date?: string;
  type?: TransactionType;
  amount?: string;
  note?: string;
}

// ==================== 快照类型 ====================

/** 资产快照实体 */
export interface AssetSnapshot {
  id: string;
  portfolioId: string;
  date: string;
  totalAsset: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 录入/覆盖快照请求体 */
export interface UpsertSnapshotRequest {
  date: string;
  totalAsset: string;
  note?: string;
}

// ==================== XIRR 查询类型 ====================

/** XIRR 时间序列数据点 */
export interface XirrSeriesPoint {
  date: string;
  xirrValue: number | null;
  label: string;
}

/** 最新 XIRR 响应 */
export interface LatestXirr {
  date: string;
  xirrValue: number | null;
}

// ==================== 净值查询类型 ====================

/** 净值时间序列数据点 */
export interface NavSeriesPoint {
  date: string;
  cumulativeNav: number | null;
  yearNav: number | null;
  shares: number | null;
  label: string;
}

/** 最新净值响应 */
export interface LatestNav {
  date: string;
  cumulativeNav: number | null;
  yearNav: number | null;
  shares: number | null;
}

// ==================== Dashboard 摘要类型 ====================

/** 组合统计摘要（前端从 latest 接口组合计算） */
export interface PortfolioSummary {
  cumulativeXirr: number | null;
  totalReturnRate: number | null;
  yearReturnRate: number | null;
  latestDate: string;
  inceptionDate: string;
}
