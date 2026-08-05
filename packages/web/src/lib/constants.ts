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
  HOLDINGS: '/holdings',
  TRANSACTIONS: '/cashflows',
  SNAPSHOTS: '/snapshots',
  XIRR_ANALYSIS: '/analysis/xirr',
  NAV_ANALYSIS: '/analysis/nav',
  ACCOUNT: '/account',
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

/**
 * 返回北京时间（UTC+8）当前日期的 YYYY-MM-DD 字符串。
 *
 * 与后端 `app-date.util.ts` 的 `todayInAppTz()` 口径完全一致：
 * 先按「应用时区 +8h」做位移，再取 UTC 日历日（`toISOString().slice(0,10)`）。
 * 位移方式与渲染方式必须配套——这里统一用 UTC 渲染，故位移量就是恒定的
 * `8h`，绝不混入 `getTimezoneOffset()`（本地偏移量），否则会与 UTC 渲染叠加
 * 产生净误差，导致跨午夜漂移（这正是后端注释明确警告要避免的坑）。
 * （中国无夏令时，恒定 +8h。）
 */
export function todayInAppTzIso(): string {
  const now = new Date();
  // 与后端 todayInAppTz() 完全一致：+8h 后取 UTC 日历日（中国无夏令时，恒定 +8h）
  const appNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return appNow.toISOString().slice(0, 10);
}

/**
 * 返回北京时间（UTC+8）当前「日期 + 时间」的 YYYY-MM-DD HH:mm:ss 字符串。
 *
 * ⚠️ 位移 +8h 仅配 `toISOString()`（UTC 渲染）使用，绝不能混入
 * `getTimezoneOffset()`。getTimezoneOffset() 是给本地 getter（如 toIsoDate）
 * 用的本地偏移量，与 UTC 渲染混用会产生净误差，导致北京 00:00–08:00 显示
 * 「昨天」（这正是 backend/app-date.util.ts 注释明确警告的坑）。
 *
 * 中国无夏令时，恒定 +8h，故位移量与本地时区无关，结果只由 UTC 时间戳决定。
 * 此函数与 todayInAppTzIso() 共用同一不变式：同一物理时刻，任意本地时区下
 * 返回值恒为该时刻对应的北京时间。
 */
export function nowInAppTzIso(): string {
  // 与后端 todayInAppTz() 同理：+8h 后取 UTC 日历日（恒定 +8h，无夏令时）
  const appNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const s = appNow.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}
