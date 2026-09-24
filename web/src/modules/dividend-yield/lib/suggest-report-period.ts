/**
 * modules/dividend-yield/lib/suggest-report-period.ts — 待划分分红「建议报告期」纯函数
 *
 * 后端**永不**判定报告期（设计 §5.2 / §5.3.5）；本模块仅在前端据源站原文标签 + 日期
 * 给出候选建议，供「指定报告期」弹窗一键采纳。**无副作用、无 IO、可单测**。
 *
 * 规则（设计 §5.3.5）：
 * - 标签 → 报告期类型：年度→ANNUAL｜中期→INTERIM｜季度→QUARTERLY｜特别→SPECIAL｜
 *   股改 / 其他 / 空 / 未知（含「重整转增」「承诺补偿」）→OTHER
 * - 合法季度格：ANNUAL=[4]｜INTERIM=[2]｜QUARTERLY=[1,3]｜SPECIAL=[1,2,3,4]｜OTHER=[1,2,3,4]
 * - 主候选 = 公告日（ANNUAL/INTERIM 另做「财年回退」：年报常在次年 1–7 月公告）
 * - 备选 = 除权日 −2 季（实测偏移 +1~+4 季、中位 2，从不同季），标记 approximate=true
 * - 两者皆空 → [] → UI 显示「无候选，须人工」
 * - 留存窗判定读 GET /settings 的 dividend_retention_years（不硬编码 cur-4）
 *
 * 7 条真样本回归见 `__tests__/suggest-report-period.test.ts`。
 */
import type { components } from '@/types/api';

/**
 * 报告期类型（§5.2b 续批 / S13）：**类型**直接取 OpenAPI 生成物——后端
 * ``models/enums.ReportPeriodType`` 是单一事实源，加值时本类型自动跟随。
 * 运行时集合（``LEGAL_QUARTERS`` / ``PERIOD_TYPE_LABELS``）仍须手写键值（下拉遍历、
 * 标签映射需要实际值），但以 ``Record<PendingPeriodType, …>`` 约束完整性——
 * 后端新增枚举值时，漏补标签会直接 ``vue-tsc`` 报错（此前靠手写联合 + ``as keyof``
 * 断言掩盖缺口）。
 */
export type PendingPeriodType = components['schemas']['ReportPeriodType'];

/** 报告期类型 → 合法季度格（其余季度在该类型下为非法键位） */
const LEGAL_QUARTERS: Record<PendingPeriodType, readonly number[]> = {
  ANNUAL: [4],
  INTERIM: [2],
  QUARTERLY: [1, 3],
  SPECIAL: [1, 2, 3, 4],
  OTHER: [1, 2, 3, 4],
};

/** 报告年份合法区间下界（上界 = 次年，运行时由弹窗表单兜底） */
export const MIN_REPORT_YEAR = 1990;

/** 建议候选 */
export interface PeriodCandidate {
  reportYear: number;
  reportQuarter: number;
  periodType: PendingPeriodType;
  /** true = 由除权日推定（备选，粗略）；false = 由公告日推定（主候选，可信） */
  approximate: boolean;
}

/** 建议输入（待划分行原文摘要） */
export interface SuggestInput {
  /** 源站「分红类型」原文标签（可空 / 未知） */
  dividendLabel: string | null;
  /** 公告日 YYYY-MM-DD（可空） */
  announcementDate: string | null;
  /** 除权日 YYYY-MM-DD（可空） */
  exDividendDate: string | null;
}

/** 标签 → 报告期类型（未知一律 OTHER；股改不单列 type，归 OTHER 并保留原文标签） */
export function inferPeriodType(
  label: string | null | undefined,
): PendingPeriodType {
  const s = (label ?? '').trim();
  if (s.includes('年度')) return 'ANNUAL';
  if (s.includes('中期')) return 'INTERIM';
  if (s.includes('季度')) return 'QUARTERLY';
  if (s.includes('特别')) return 'SPECIAL';
  return 'OTHER';
}

/** 季度是否为该报告期类型的合法格 */
export function isValidQuarter(
  periodType: PendingPeriodType,
  quarter: number,
): boolean {
  return LEGAL_QUARTERS[periodType].includes(quarter);
}

/** 该报告期类型的合法季度集合（弹窗据此置灰非法季度 / 单格联动禁用） */
export function legalQuarters(periodType: PendingPeriodType): readonly number[] {
  return LEGAL_QUARTERS[periodType];
}

/** 报告期类型的展示名（弹窗下拉与摘要共用） */
export const PERIOD_TYPE_LABELS: Record<PendingPeriodType, string> = {
  ANNUAL: '年度（年报）',
  INTERIM: '中期（半年报）',
  QUARTERLY: '季度',
  SPECIAL: '特别分配',
  OTHER: '其他',
};

/** 报告年份上界（当前年 + 1） */
export function maxReportYear(currentYear: number): number {
  return currentYear + 1;
}

/** 解析 YYYY-MM-DD（容忍仅 YYYY-MM）；非法返回 null */
function parseYearMonth(v: string | null): { year: number; month: number } | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** 月份 → 季度（1~4） */
function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

/** 自 (year, quarter) 起向后推进到第一个合法格（含自身） */
function snapForwardToLegal(
  year: number,
  quarter: number,
  legal: readonly number[],
): { year: number; quarter: number } {
  let y = year;
  let q = quarter;
  for (let i = 0; i < 8; i += 1) {
    if (legal.includes(q)) return { year: y, quarter: q };
    q += 1;
    if (q > 4) {
      q = 1;
      y += 1;
    }
  }
  return { year, quarter: legal[0] };
}

/** 主候选：公告日 → 报告期（ANNUAL / INTERIM 做财年回退） */
function primaryFromAnnouncement(
  periodType: PendingPeriodType,
  year: number,
  month: number,
): { year: number; quarter: number } {
  if (periodType === 'ANNUAL') {
    // 年报常在次年 1–7 月公告 → 公告落在 1–7 月时报告年取上一年
    const reportYear = month <= 7 ? year - 1 : year;
    return snapForwardToLegal(reportYear, 4, LEGAL_QUARTERS.ANNUAL);
  }
  if (periodType === 'INTERIM') {
    // 中期（半年报）常在 7–8 月公告 → 1–6 月公告视为上一年中期
    const reportYear = month <= 6 ? year - 1 : year;
    return snapForwardToLegal(reportYear, 2, LEGAL_QUARTERS.INTERIM);
  }
  return snapForwardToLegal(
    year,
    quarterOfMonth(month),
    LEGAL_QUARTERS[periodType],
  );
}

/** 备选：除权日 −2 季后再吸附到合法格（向后续推，如 ANNUAL 从 Q1 → 同年 Q4） */
function alternateFromEx(
  periodType: PendingPeriodType,
  year: number,
  month: number,
): { year: number; quarter: number } {
  let y = year;
  let q = quarterOfMonth(month) - 2;
  while (q < 1) {
    q += 4;
    y -= 1;
  }
  return snapForwardToLegal(y, q, LEGAL_QUARTERS[periodType]);
}

/**
 * 生成建议报告期候选（主候选在前、备选在后；同格去重）。
 *
 * @returns 空数组表示「无候选，须人工」。
 */
export function suggestReportPeriod(input: SuggestInput): PeriodCandidate[] {
  const periodType = inferPeriodType(input.dividendLabel);
  const out: PeriodCandidate[] = [];

  const ann = parseYearMonth(input.announcementDate);
  if (ann) {
    const p = primaryFromAnnouncement(periodType, ann.year, ann.month);
    out.push({
      reportYear: p.year,
      reportQuarter: p.quarter,
      periodType,
      approximate: false,
    });
  }

  const ex = parseYearMonth(input.exDividendDate);
  if (ex) {
    const a = alternateFromEx(periodType, ex.year, ex.month);
    const dup = out.some(
      (c) => c.reportYear === a.year && c.reportQuarter === a.quarter,
    );
    if (!dup) {
      out.push({
        reportYear: a.year,
        reportQuarter: a.quarter,
        periodType,
        approximate: true,
      });
    }
  }

  return out;
}

/** 留存窗下界（含）：窗口 = [currentYear - retentionYears + 1, currentYear] */
export function retentionMinYear(
  currentYear: number,
  retentionYears: number,
): number {
  return currentYear - retentionYears + 1;
}

/** 报告年是否落在留存窗外（转正后可能被留存清理删除，建议改「忽略」） */
export function isOutsideRetention(
  reportYear: number,
  currentYear: number,
  retentionYears: number,
): boolean {
  return reportYear < retentionMinYear(currentYear, retentionYears);
}

