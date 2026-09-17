/**
 * api/dividend-yield.api.ts — 股息率排名 API
 *
 * 对应后端 /api/dividend-yield/*（http 已按信封解包 data，url 相对 baseURL=/api）：
 * - GET  /dividend-yield/rankings              — 股息率榜单（分页/排序）
 * - GET  /dividend-yield/top20                 — Top20 股息率看板（后端剔除 suspicious、封顶 20）
 * - GET  /dividend-yield/{master_id}/dividends  — 单证券分红明细（按报告期，仅有分红期次）
 * - GET  /dividend-yield/{master_id}/curve      — 单证券股息率曲线（近 days 天）
 * - GET  /dividend-yield/{master_id}/implied-price — 按目标收益率反推隐含价格
 * - GET  /dividend-yield/settings       — 阈值 + 三接口源设置（admin-only）
 * - PUT  /dividend-yield/settings       — 更新设置（admin-only）
 *
 * 端点/字段契约与后端实现已对齐（见 web/src/api/types.ts 的股息率排名 API 段）。
 */

import { http } from '@/lib/api-client';
import type {
  DividendYieldRankResponse,
  DividendYieldTop20Response,
  DividendYieldCurveResponse,
  DividendYieldSort,
  DividendYieldSettingsOut,
  ImpliedPriceResult,
  UpdateDividendYieldSettingsDto,
} from './types';

/** 股息率榜单过滤参数（§8.1；include_no_dividend 默认 false=剔除近两年无分红） */
export interface DividendYieldRankFilters {
  exchange?: string;
  mode?: 'TTM' | 'LFY';
  min_consecutive?: number;
  include_proposed?: boolean;
  include_no_dividend?: boolean;
  /** 关键字过滤：证券代码 / 名称模糊匹配（服务端 ilike） */
  q?: string;
}

/** 股息率榜单（分页/排序/过滤） */
export function getDividendYieldRank(
  page: number,
  pageSize: number,
  sort: DividendYieldSort = 'dividend_yield',
  filters: DividendYieldRankFilters = {},
): Promise<DividendYieldRankResponse> {
  return http.get<DividendYieldRankResponse>(
    '/dividend-yield/rankings',
    { params: { page, pageSize, sort, ...filters } },
  );
}

/** Top20 股息率看板（后端已剔除 suspicious、封顶 20） */
export function getDividendYieldTop20(): Promise<DividendYieldTop20Response> {
  return http.get<DividendYieldTop20Response>('/dividend-yield/top20');
}

/** 单证券股息率曲线（近 days 天） */
export function getDividendYieldCurve(
  masterId: string,
  days = 365,
): Promise<DividendYieldCurveResponse> {
  return http.get<DividendYieldCurveResponse>(
    `/dividend-yield/${masterId}/curve`,
    { params: { days } },
  );
}

/** 单条分红明细（按报告期） */
export interface SecurityDividendItem {
  reportYear: number;
  reportQuarter: number;
  periodType: 'ANNUAL' | 'INTERIM' | 'QUARTERLY' | 'SPECIAL';
  /** 报告期展示名：2025年报 / 2025半年报 / 2025三季报 / 2023特别分配（§5.1 命名） */
  periodLabel: string;
  /** 分红方案展示名：源站口径「10派3元」（库内每股金额 ×10 折算） */
  planLabel: string;
  /** 每股现金分红（元；字符串防前端类型漂移） */
  cashPerShare: string;
  /** PROPOSED 预案 / PAID 已派发 / REJECTED 否决 */
  status: string;
  exDividendDate: string | null;
  announcementDate: string | null;
}

/** 单证券分红明细响应（只含 cash_per_share > 0 的期次，按报告期倒序） */
export interface SecurityDividendListResponse {
  masterId: string;
  items: SecurityDividendItem[];
}

/** 单证券分红明细（按报告期，供详情面板展示） */
export function getSecurityDividends(
  masterId: string,
): Promise<SecurityDividendListResponse> {
  return http.get<SecurityDividendListResponse>(
    `/dividend-yield/${masterId}/dividends`,
  );
}

/** 按目标收益率反推隐含价格（target_ratio 为小数比率 0 < x <= 1） */
export function getDividendYieldImpliedPrice(
  masterId: string,
  targetRatio: number,
): Promise<ImpliedPriceResult> {
  return http.get<ImpliedPriceResult>(
    `/dividend-yield/${masterId}/implied-price`,
    { params: { target_ratio: targetRatio } },
  );
}

/** 股息率阈值 + 三接口源设置（admin-only） */
export function getDividendYieldSettings(): Promise<DividendYieldSettingsOut> {
  return http.get<DividendYieldSettingsOut>('/dividend-yield/settings');
}

/** 更新股息率阈值 + 三接口源设置（admin-only；写时用 *_interface_id 字段） */
export function updateDividendYieldSettings(
  payload: UpdateDividendYieldSettingsDto,
): Promise<DividendYieldSettingsOut> {
  return http.put<DividendYieldSettingsOut>(
    '/dividend-yield/settings',
    payload,
  );
}

/** 手动全量重建股息率派生快照（admin-only；替代原系统定时任务） */
export function rebuildDividendYield(): Promise<{ summary: string }> {
  return http.post<{ summary: string }>('/dividend-yield/rebuild');
}

/** 手动触发特别分红历史回补（§6.9；admin-only，后端异步后台执行、立即返回） */
export function backfillSpecialDividends(): Promise<{
  message: string;
  job_id: string;
}> {
  return http.post<{ message: string; job_id: string }>(
    '/dividend-yield/backfill-specials',
  );
}

/** 手动触发历史行情缺口回补响应（admin-only，后端 fire-and-forget 立即返回） */
export interface BackfillPricesResult {
  message: string;
  start_date: string;
  security_count: number;
}

/** 取消在途回补的响应 */
export interface CancelPriceBackfillResult {
  message: string;
  cancelled_start_date: string;
}

/** 手动触发历史行情缺口回补（初始化块；admin-only，后端异步后台执行、立即返回） */
export function backfillDailyPrices(
  startDate: string,
): Promise<BackfillPricesResult> {
  return http.post<BackfillPricesResult>('/dividend-yield/backfill-prices', {
    start_date: startDate,
  });
}

/** 取消在途的历史行情回补（admin-only；清 price_backfill_start_date，唯一 API 退路） */
export function cancelPriceBackfill(): Promise<CancelPriceBackfillResult> {
  return http.delete<CancelPriceBackfillResult>('/dividend-yield/backfill-prices');
}