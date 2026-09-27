/**
 * api/dividend-yield.api.ts — 股息率排名 API
 *
 * 对应后端 /api/dividend-yield/*（http 已按信封解包 data，url 相对 baseURL=/api）：
 * - GET  /dividend-yield/rankings              — 股息率榜单（分页/排序）
 * - GET  /dividend-yield/top20                 — Top20 股息率看板（后端剔除 suspicious、封顶 20）
 * - GET  /dividend-yield/{master_id}/dividends  — 单证券分红明细（按报告期，仅有分红期次）
 * - GET  /dividend-yield/{master_id}/curve      — 单证券股息率曲线（近 days 天）
 * - GET  /dividend-yield/{master_id}/implied-price — 按目标收益率反推隐含价格
 * - GET  /dividend-yield/settings       — 全局配置读取（登录可读）
 * - PUT  /dividend-yield/settings       — 更新全局配置（admin-only）
 * - POST /dividend-yield/rebuild                — 全量重建派生快照（admin-only）
 * - POST /dividend-yield/seed-initial-dividends — 触发历史分红补齐 / 播种（admin-only，fire-and-forget）
 *
 * 端点/字段契约与后端实现已对齐（见 web/src/api/types.ts 的股息率排名 API 段）。
 */

import { http } from '@/lib/api-client';
import type {
  DividendYieldSort,
  PaginatedResponse,
} from './types';
// 待人工划分分红端点响应契约直接复用 OpenAPI 生成类型（批次 C 已重生成 types/api.ts）。
import type { components } from '../types/api';

type PendingDividendOut = components['schemas']['PendingDividendOut'];
type PendingDividendSummaryOut = components['schemas']['PendingDividendSummaryOut'];
type PendingAssignResultOut = components['schemas']['PendingAssignResultOut'];
type PendingIgnoreResultOut = components['schemas']['PendingIgnoreResultOut'];
type PendingReopenResultOut = components['schemas']['PendingReopenResultOut'];
type BatchOperationOut = components['schemas']['BatchOperationOut'];

// 榜单/推算契约（R3 续批收口）：此前 rankings/top20/implied-price 三端点无 response_model，
// 前端手写 DividendYieldRankItem/ImpliedPriceResult，wire 上 Decimal→str 的字段被声明为
// number，与后端加字段一样静默漂移。现由生成物唯一承载（后端改字段 vue-tsc 即报错）。
/** 股息率榜单行（DividendYieldRankItemOut；dividend_yield 等 Decimal 字段为 string） */
export type DividendYieldRankItem =
  components['schemas']['DividendYieldRankItemOut'];
/** 股息率榜单分页响应 */
export type DividendYieldRankResponse =
  components['schemas']['DividendYieldRankPageOut'];
/** Top20 + 连续分红榜双榜响应（§8.3） */
export type DividendYieldTop20Response =
  components['schemas']['DividendYieldTop20Out'];
/** 隐含股息收益率反推价格响应（§9；target_ratio 等比率字段为 string） */
export type ImpliedPriceResult = components['schemas']['ImpliedPriceResultOut'];

// 股息率全局配置契约（B7/A8）：**响应与请求体都**直接复用 OpenAPI 生成类型——这两个端点
// 此前未声明 response_model，`docs/openapi.json` 里根本没有该类型，前端只能手写
// （原 `api/types.ts` 的 DividendYieldSettingsOut / UpdateDividendYieldSettingsDto），
// 「后端加字段、前端手写漏抄」因此静默漂移过一次（`dividend_retention_years`）。
// 现由生成物唯一承载；若后端改字段，前端类型自动跟随（`pnpm run lint` 即报错）。
export type DividendYieldSettingsOut =
  components['schemas']['DividendYieldSettingsOut'];
export type SettingsUpdateBody = components['schemas']['SettingsUpdateBody'];

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

/** 所有有分红的证券（供股息价格推算选择框，无分页上限，§10.2）。
 *  契约来自 OpenAPI 生成类型（DividendSecurityListOut，R3 补 response_model 后落契约）。 */
export type DividendSecurityListResponse =
  components['schemas']['DividendSecurityListOut'];
/** 股息价格推算选择框候选行（DividendSecurityItemOut；numerator_per_share 为 Decimal→str） */
export type DividendSecurityCandidate =
  components['schemas']['DividendSecurityItemOut'];

/** 所有有分红的证券（供股息价格推算选择框，无分页上限，§10.2） */
export function getDividendYieldSecurities(): Promise<DividendSecurityListResponse> {
  return http.get<DividendSecurityListResponse>('/dividend-yield/securities');
}

/** 单条分红明细（按报告期） */
export interface SecurityDividendItem {
  reportYear: number;
  reportQuarter: number;
  /** 报告期类型：§5.2b 续批，取生成契约（后端 ReportPeriodType 为单一事实源） */
  periodType: components['schemas']['ReportPeriodType'];
  /** 报告期展示名：2025年报 / 2025半年报 / 2025三季报 / 2023特别分配（§5.1 命名） */
  periodLabel: string;
  /** 分红方案展示名：源站口径「10派3元」（库内每股金额 ×10 折算） */
  planLabel: string;
  /** 每股现金分红（元；字符串防前端类型漂移） */
  cashPerShare: string;
  /** 每股送股比例（股；字符串防前端类型漂移）；无送股为 null */
  bonusShareRatio?: string | null;
  /** 每股转增比例（股；字符串防前端类型漂移）；无转增为 null */
  convertRatio?: string | null;
  /** 源站「分红类型」原文标签（如「股改分红」「重整转增」）；无标签为 null（E6 修复） */
  dividendLabel: string | null;
  /** PROPOSED 预案 / PAID 已派发 / REJECTED 否决（§5.2b 续批：取生成契约 DividendStatus） */
  status: components['schemas']['DividendStatus'];
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

/** 股息率全局配置读取（登录可读；响应形状 = OpenAPI `DividendYieldSettingsOut`） */
export function getDividendYieldSettings(): Promise<DividendYieldSettingsOut> {
  return http.get<DividendYieldSettingsOut>('/dividend-yield/settings');
}

/** 更新股息率全局配置（admin-only；写时用 *_interface_id 字段） */
export function updateDividendYieldSettings(
  payload: SettingsUpdateBody,
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

/**
 * 手动触发历史分红补齐 / 播种（admin-only；后端异步后台执行、立即返回）。
 *
 * 契约说明（勿照抄旧 backfillSpecialDividends 的声明）：端点为 fire-and-forget，
 * 返回体只有 { message }；旧声明里的 job_id 后端从不返回，已随迁移
 * 0015_remove_special_backfill_task 消失，故此处只声明 { message: string }。
 */
export function seedInitialDividends(): Promise<{ message: string }> {
  return http.post<{ message: string }>(
    '/dividend-yield/seed-initial-dividends',
  );
}

/**
 * 查询历史分红补齐 / 播种的实时进度（admin-only）。
 *
 * 返回类型直接取生成契约 ``SeedProgressOut``（S15）：此前该形状只有前端手写接口 +
 * 后端手工 dict 两处，字段改名只会让面板显示 ``undefined`` 而 ``vue-tsc`` 无感。
 */
export function getSeedProgress(): Promise<components['schemas']['SeedProgressOut']> {
  return http.get<components['schemas']['SeedProgressOut']>(
    '/dividend-yield/seed-initial-dividends/progress',
  );
}

/** 取消正在运行的历史分红补齐 / 播种（admin-only）；已完成部分保留，可再次触发续跑 */
export function cancelSeedInitialDividends(): Promise<{ message: string }> {
  return http.post<{ message: string }>(
    '/dividend-yield/seed-initial-dividends/cancel',
  );
}

// ============================================================================
// 待人工划分分红（批次 C/D · /dividend-yield/pending-dividends/*）
//
// 「无报告期」的现金分红行落在 staging 表，交人工指定报告期。后端**永不**判定报告期，
// 仅前端据原文标签 + 日期给建议（见 lib/suggest-report-period.ts）。
// 读端点（list/summary）对 admin/auditor 开放；写端点仅 admin。
// ============================================================================

/** 待划分列表筛选/分页参数（排序固定 created_at DESC, id DESC，后端不提供 sort） */
export interface PendingDividendFilters {
  /** 状态筛选（不传 = 全部；§5.2b 续批：取生成契约 DividendPendingStatus） */
  status?: components['schemas']['DividendPendingStatus'];
  /** 源站原文标签精确匹配（不传 = 全部） */
  label?: string;
  /** 关键字：证券代码 / 名称模糊（服务端 ilike） */
  q?: string;
  page?: number;
  pageSize?: number;
}

/** 划分单笔请求体（reportYear/reportQuarter/periodType 由弹窗表单给出） */
export interface PendingAssignPayload {
  reportYear: number;
  reportQuarter: number;
  /** 报告期类型（§5.2b 续批：取生成契约，与 SecurityDividendItem 同枚举） */
  periodType: components['schemas']['ReportPeriodType'];
}

/** 批量划分单条（= 单笔请求体 + 待划分行 id） */
export type PendingAssignItemPayload = PendingAssignPayload & { id: string };

/** 待划分分页列表（固定排序；筛选 status/label/q） */
export function listPendingDividends(
  filters: PendingDividendFilters = {},
): Promise<PaginatedResponse<PendingDividendOut>> {
  return http.get<PaginatedResponse<PendingDividendOut>>(
    '/dividend-yield/pending-dividends',
    { params: filters },
  );
}

/** 待划分概览：各状态计数 + 标签候选集 labels[] */
export function getPendingDividendSummary(): Promise<PendingDividendSummaryOut> {
  return http.get<PendingDividendSummaryOut>(
    '/dividend-yield/pending-dividends/summary',
  );
}

/** 划分单笔（写回分红主表 + 置 ASSIGNED；主表同格已存在则 conflict=true 不覆盖） */
export function assignPendingDividend(
  id: string,
  payload: PendingAssignPayload,
): Promise<PendingAssignResultOut> {
  return http.post<PendingAssignResultOut>(
    `/dividend-yield/pending-dividends/${id}/assign`,
    payload,
  );
}

/** 批量划分（逐项独立提交；部分失败返回 { succeeded, failed[] }） */
export function batchAssignPendingDividends(
  items: PendingAssignItemPayload[],
): Promise<BatchOperationOut> {
  return http.post<BatchOperationOut>(
    '/dividend-yield/pending-dividends/batch-assign',
    { items },
  );
}

/** 忽略单笔（PENDING → IGNORED；不写回主表） */
export function ignorePendingDividend(
  id: string,
): Promise<PendingIgnoreResultOut> {
  return http.post<PendingIgnoreResultOut>(
    `/dividend-yield/pending-dividends/${id}/ignore`,
  );
}

/** 批量忽略（逐项独立提交；部分失败返回 { succeeded, failed[] }） */
export function batchIgnorePendingDividends(
  ids: string[],
): Promise<BatchOperationOut> {
  return http.post<BatchOperationOut>(
    '/dividend-yield/pending-dividends/batch-ignore',
    { ids },
  );
}

/** 撤销指定（仅 ASSIGNED 可撤销；连带删除 assign 写入的主表同键行） */
export function reopenPendingDividend(
  id: string,
): Promise<PendingReopenResultOut> {
  return http.post<PendingReopenResultOut>(
    `/dividend-yield/pending-dividends/${id}/reopen`,
  );
}