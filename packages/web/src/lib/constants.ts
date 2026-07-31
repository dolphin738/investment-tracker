/**
 * lib/constants.ts — 常量定义
 *
 * - API_PATH：API 路径常量
 * - ROUTE_PATH：前端路由路径
 * - 查询维度/聚合方式枚举值（与 shared 包 QueryGranularity/AggregationMethod 一致）
 * - 本地存储键名
 */

// ===== API 路径前缀 =====
export const API_PREFIX = '/api';
export const API_BASE_URL = '/api';

// ===== 认证相关 =====
export const AUTH_TOKEN_KEY = 'investment_tracker_token';
export const AUTH_USER_KEY = 'investment_tracker_user';

// ===== 前端路由路径 =====
export const ROUTE_PATH = {
  LOGIN: '/login',
  REGISTER: '/register',
  DASHBOARD: '/',
  TRANSACTIONS: '/transactions',
  SNAPSHOTS: '/snapshots',
  XIRR_ANALYSIS: '/analysis/xirr',
  NAV_ANALYSIS: '/analysis/nav',
  SETTINGS: '/settings',
} as const;

// ===== 查询维度选项（用于 UI 下拉/Tab） =====
export const GRANULARITY_OPTIONS = [
  { value: 'day', label: '按日' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
  { value: 'year', label: '按年' },
] as const;

// ===== 聚合方式选项 =====
export const AGGREGATION_OPTIONS = [
  { value: 'last', label: '期末值' },
  { value: 'avg', label: '平均值' },
] as const;

// ===== 默认分页参数 =====
export const DEFAULT_PAGE_SIZE = 20;

// ===== 默认日期范围（近 1 年） =====
export function getDefaultDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  return {
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
  };
}

/** 将 Date 转为 YYYY-MM-DD（本地时区） */
export function toIsoDate(date: Date): string {
  const yyyy = date.getFullYear().toString();
  const MM = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  return `${yyyy}-${MM}-${dd}`;
}
