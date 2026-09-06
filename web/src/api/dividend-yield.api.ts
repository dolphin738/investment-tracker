/**
 * api/dividend-yield.api.ts — 股息率排名 API
 *
 * 对应后端 /api/dividend-yield/*（http 已按信封解包 data，url 相对 baseURL=/api）：
 * - GET  /dividend-yield/rankings              — 股息率榜单（分页/排序）
 * - GET  /dividend-yield/top20                 — Top20 股息率看板（后端剔除 suspicious、封顶 20）
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

/** 股息率榜单（分页/排序） */
export function getDividendYieldRank(
  page: number,
  pageSize: number,
  sort: DividendYieldSort = 'dividend_yield',
): Promise<DividendYieldRankResponse> {
  return http.get<DividendYieldRankResponse>(
    '/dividend-yield/rankings',
    { params: { page, pageSize, sort } },
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
    `/dividend-yield/curve/${masterId}`,
    { params: { days } },
  );
}

/** 按目标收益率反推隐含价格（target_ratio 为小数比率 0 < x <= 1） */
export function getDividendYieldImpliedPrice(
  masterId: string,
  targetRatio: number,
): Promise<ImpliedPriceResult> {
  return http.get<ImpliedPriceResult>(
    `/dividend-yield/implied-price/${masterId}`,
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