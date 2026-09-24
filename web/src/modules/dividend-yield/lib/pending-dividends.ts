/**
 * modules/dividend-yield/lib/pending-dividends.ts — 待划分分红的**纯函数**判定与投影
 *
 * 抽出的动机（S10 / S17）：此前「哪些行可勾选」在门面（全选）与哑表格（行内 checkbox）各写
 * 一遍、口径分裂；`suggestionPayload` 又只服务门面。两者都是无副作用的纯逻辑，收口到这里
 * 后既可单测，也保证「可操作」判定只有一处定义。
 */
import type { components } from '@/types/api';
import type { PendingAssignItemPayload } from '@/api/dividend-yield.api';
import { PERIOD_TYPE_LABELS, suggestReportPeriod } from './suggest-report-period';

type PendingDividendOut = components['schemas']['PendingDividendOut'];

/** 批量端点 `failed[]` 元素（直接取生成契约，避免再手写一份同形副本） */
export type BatchFailedItem = components['schemas']['BatchFailedItemOut'];

/**
 * 筛选状态联合类型（§4 收口）：门面与 FilterBar **必须共用**。
 * 此前 FilterBar 把 `status` 声明为 `string` 抹平了门面的联合类型——父级收窄、子级放宽，
 * 联合形同虚设（新状态拼错 `vue-tsc` 无感）。空串 = 「全部」。
 */
export type PendingStatusFilter =
  | ''
  | components['schemas']['DividendPendingStatus'];

/**
 * 唯一「可勾选 / 可批量操作」判定：**仅 `PENDING` 行**。
 *
 * 与后端语义一致——`assign` / `ignore` 只接受 `PENDING`，非 PENDING 会返回
 * `INVALID_STATE`。门面（表头全选）与表格（行内 checkbox）**必须**共用本函数，否则会出现
 * 「全选只覆盖 PENDING、但行内能把 ASSIGNED 勾上」的口径分裂：批量提交后用户看到
 * 「失败 N 笔」，而真实原因是「这些行本不可操作」。
 */
export function isSelectablePendingRow(row: PendingDividendOut): boolean {
  return row.status === 'PENDING';
}

/**
 * 由行生成建议 payload（无候选返回 `null`，调用方过滤）。
 *
 * 类型复用 api 层的 `PendingAssignItemPayload`（批量端点 items[] 元素），不另立同形接口。
 */
export function suggestionPayload(
  row: PendingDividendOut,
): PendingAssignItemPayload | null {
  const c = suggestReportPeriod({
    dividendLabel: row.dividendLabel ?? null,
    announcementDate: row.announcementDate ?? null,
    exDividendDate: row.exDividendDate ?? null,
  })[0];
  if (!c) return null;
  return {
    id: row.id,
    reportYear: c.reportYear,
    reportQuarter: c.reportQuarter,
    periodType: c.periodType,
  };
}

/**
 * 建议值统一展示格式（§4 收口，owner 裁决 2026-09-25：以批量预览口径为准）。
 *
 * 格式：`{code} {reportYear}Q{reportQuarter} {类型标签}` → 「600519 2022Q4 特别分配」。
 * `approximate=true`（除权日推定的备选候选）时追加「（除权日推定，粗略）」后缀。
 *
 * **三处必须共用本函数**（此前各写一遍已漂移出三种格式）：
 * Table 报告期列（PENDING 行）/ AssignDialog 候选区 / BatchDialog 批量预览。
 */
export function formatSuggestionPreview(
  code: string | null | undefined,
  candidate: {
    reportYear: number;
    reportQuarter: number;
    periodType: string;
    approximate?: boolean;
  },
): string {
  const who = code && code.trim() ? code : '未知代码';
  const approx = candidate.approximate ? '（除权日推定，粗略）' : '';
  const label =
    PERIOD_TYPE_LABELS[candidate.periodType as keyof typeof PERIOD_TYPE_LABELS] ??
    '其他';
  return `${who} ${candidate.reportYear}Q${candidate.reportQuarter} ${label}${approx}`;
}
