/**
 * lib/constants.ts — 常量定义
 *
 * - API_PATH：API 路径常量
 * - ROUTE_PATH：前端路由路径
 * - 查询维度/聚合方式枚举值（与 shared 包 QueryGranularity/AggregationMethod 一致）
 * - 本地存储键名
 */

import { ExportType } from '@/lib/types';
import { formatDate } from '@/lib/utils';

// ===== 系统名称（全站统一，维护此处即可）=====
export const APP_NAME = '投资收益统计系统';

// ===== API 路径前缀 =====
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
  DIVIDEND_YIELD: '/dividend-yield',
  DIVIDEND_YIELD_TOP: '/dividend-yield/top',
  SETTINGS: '/settings',
  ADMIN: '/admin',
  ADMIN_TASKS: '/admin/tasks',
  ADMIN_LOGS: '/admin/logs',
  ADMIN_GLOBAL_SETTINGS: '/admin/global-settings',
} as const;

// ===== 路由持久化键 =====
// 命名风格与 invest:admin-active-module 一致（invest: 前缀 + 短横线语义）。
export const AUTH_RETURN_KEY = 'invest:auth-return';

// ===== Select 空值哨兵 =====
/**
 * reka-ui 的 ``<SelectItem />`` **禁止** ``value=""``（空串会在 setup 阶段抛
 * "must have a value prop that is not an empty string"），因此「未选中 / 不设置」
 * 一律用此哨兵表示，提交时再映射回 null。
 *
 * 原定义在 ``modules/query/quick-range.ts``（QUICK_RANGE_PLACEHOLDER），上移此处
 * 作为全站单一真源；各模块不得再各自写魔法字符串。
 */
export const SELECT_EMPTY_VALUE = '__none__';

// ===== 历史行情回补模式（与后端 PRICE_BACKFILL_MODES 对齐，迁移 0021） =====
/**
 * ``legacy``：起点覆盖即整只跳过（只看「该证券有没有早于起点的日线行」），
 *   **中间的空洞永不回填**——存量默认，改动前的行为。
 * ``gap``：严格补洞——按交易日历逐日比对「应有交易日 vs 已有日线」，缺失的日子
 *   逐个回填（会重新抓取起点已覆盖的证券，代价是重复消耗额度）。
 * ``rebuild``：全量重抓——**忽略覆盖度**，对全部有分红记录的证券按 master_id 游标推进；
 *   且为**清空后重建**：写前先删该证券在回补区间内的既有日线，再按当前源 + 复权口径整段
 *   写入，**不留旧源/旧复权口径的数据**（源如今给不到的日期宁可空缺）。区间下限取
 *   「配置起点与该证券已有最早日期中更早者」，故早于配置起点的存量历史也会被一并重建。
 *   走完证券池即结束。
 *
 * 后端对越界值 400，前端下拉只给这三个选项，故无需再校验。
 */
export const PRICE_BACKFILL_MODE_LEGACY = 'legacy';
export const PRICE_BACKFILL_MODE_GAP = 'gap';
export const PRICE_BACKFILL_MODE_REBUILD = 'rebuild';
export const PRICE_BACKFILL_MODE_OPTIONS = [
  {
    value: PRICE_BACKFILL_MODE_LEGACY,
    label: '常规（起点覆盖即跳过，不补空洞）',
  },
  { value: PRICE_BACKFILL_MODE_GAP, label: '严格补洞（按交易日历逐日补齐）' },
  {
    value: PRICE_BACKFILL_MODE_REBUILD,
    label: '全量重抓（清空区间后重建，不留旧数据）',
  },
] as const;

/** 模式短标签（用于「当前模式：X」等展示位，避免长说明文案重复） */
export const PRICE_BACKFILL_MODE_SHORT_LABEL: Record<string, string> = {
  [PRICE_BACKFILL_MODE_LEGACY]: '常规',
  [PRICE_BACKFILL_MODE_GAP]: '严格补洞',
  [PRICE_BACKFILL_MODE_REBUILD]: '全量重抓',
};

// ===== 历史行情回补「复权方式」（与后端 PRICE_BACKFILL_ADJUSTS 对齐，迁移 0022） =====
/**
 * 回补抓取传给 akshare ``stock_zh_a_hist`` 的 ``adjust`` 入参：
 * - 不复权（默认，``''``）：原始成交价（含除权跳空），与既有行为零差异；
 * - 前复权（``qfq``）：保持当前价、历史价时变；
 * - 后复权（``hfq``）：保持历史价、反映长期真实收益。
 *
 * ⚠️ reka-ui ``<SelectItem />`` 禁止 ``value=""``（空串），故「不复权」在 UI 用
 * ``SELECT_EMPTY_VALUE`` 哨兵表示，表单内部仍存服务端值（``''``），做双向映射。
 *
 * 后端对越界值 400，前端下拉只给这三项，故无需再校验。
 */
export const PRICE_BACKFILL_ADJUST_NONE = '';
export const PRICE_BACKFILL_ADJUST_QFQ = 'qfq';
export const PRICE_BACKFILL_ADJUST_HFQ = 'hfq';
export const PRICE_BACKFILL_ADJUST_OPTIONS = [
  { value: PRICE_BACKFILL_ADJUST_NONE, label: '不复权（默认）' },
  { value: PRICE_BACKFILL_ADJUST_QFQ, label: '前复权' },
  { value: PRICE_BACKFILL_ADJUST_HFQ, label: '后复权' },
] as const;

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

// ===== CSV 导出类别选项（对齐 shared ExportType，供导出下拉渲染）=====
export const EXPORT_TYPE_OPTIONS = [
  { value: ExportType.SECURITIES, label: '标的主数据' },
  { value: ExportType.SECURITY_TRADES, label: '证券买卖流水' },
  { value: ExportType.CASH_FLOWS, label: '出入金流水' },
  { value: ExportType.CASH_BALANCES, label: '现金余额记录' },
  { value: ExportType.SECURITY_PRICES, label: '证券价格记录' },
  { value: ExportType.ASSET_SNAPSHOTS, label: '资产记录' },
  { value: ExportType.NAV_SERIES, label: '净值序列' },
] as const;

/** 将 Date 转为 YYYY-MM-DD（本地时区）。委托 formatDate 复用同一日期渲染口径（REP-035）。 */
export function toIsoDate(date: Date): string {
  return formatDate(date, 'yyyy-MM-dd');
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
