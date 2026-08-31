/**
 * lib/utils.ts — cn() 类名合并工具 + 日期/数字格式化
 *
 * - cn() 合并 clsx + tailwind-merge，处理 Tailwind 类冲突
 * - formatDate/formatPercent/formatDecimal 格式化展示数据
 * - 业务约定：日期 YYYY-MM-DD；XIRR 小数形式 (0.1234 = 12.34%)，展示 2 位百分比；
 *   净值 4 位小数；金额 2 位小数。
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 Tailwind 类名，处理冲突（后者覆盖前者）。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 格式化日期为 YYYY-MM-DD（默认）或自定义 locale 格式。
 * 输入支持 ISO 字符串或 Date 对象。
 */
export function formatDate(
  value: string | Date | null | undefined,
  pattern: 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'MM-dd' | 'yyyy-MM' | 'yyyy' = 'yyyy-MM-dd',
): string {
  if (!value) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';

  const yyyy = date.getFullYear().toString();
  const MM = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');

  switch (pattern) {
    case 'yyyy-MM-dd':
      return `${yyyy}-${MM}-${dd}`;
    case 'yyyy/MM/dd':
      return `${yyyy}/${MM}/${dd}`;
    case 'MM-dd':
      return `${MM}-${dd}`;
    case 'yyyy-MM':
      return `${yyyy}-${MM}`;
    case 'yyyy':
      return yyyy;
    default:
      return `${yyyy}-${MM}-${dd}`;
  }
}

/**
 * 格式化日期时间为 YYYY-MM-DD HH:mm:ss（本地时区）。
 * 输入支持 ISO 字符串或 null；非法/空值返回 '-'。
 * 收敛自 SchedulePage / LogCenterPage 的逐字重复本地实现（REP-034）。
 */
export function formatDateTime(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 格式化选项（供 formatCurrency / formatPercent / formatDecimal 使用） */
export interface FormatOptions {
  /** 小数位数，覆盖位置参数 digits */
  decimals?: number;
}

/** 金额格式化选项 */
export interface FormatCurrencyOptions extends FormatOptions {
  /** 千分位分隔（默认 true） */
  thousands?: boolean;
  /** 万 / 亿缩写（默认 false） */
  abbreviate?: boolean;
}

/**
 * 将小数形式百分比（0.1234）格式化为 "12.34%"。
 * 输入 null 时返回 '-'。
 * digits 保留小数位数，默认 2。
 * options.decimals 覆盖 digits。
 */
export function formatPercent(
  value: number | string | null | undefined,
  digits = 2,
  options?: FormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '-';
  const dec = options?.decimals ?? digits;
  return `${(num * 100).toFixed(dec)}%`;
}

/**
 * 格式化净值/小数（默认 4 位小数）。
 * options.decimals 覆盖 digits。
 */
export function formatDecimal(
  value: number | string | null | undefined,
  digits = 4,
  options?: FormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '-';
  const dec = options?.decimals ?? digits;
  return num.toFixed(dec);
}

/**
 * 格式化金额（默认 2 位小数，千分位开，带 ¥ 前缀）。
 *
 * - options.thousands 控制千分位（默认 true）
 * - options.abbreviate 控制万 / 亿缩写（默认 false）
 * - options.decimals 覆盖 digits
 */
export function formatCurrency(
  value: number | string | null | undefined,
  digits = 2,
  options?: FormatCurrencyOptions,
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '-';
  const dec = options?.decimals ?? digits;
  const useThousands = options?.thousands ?? true;
  const useAbbrev = options?.abbreviate ?? false;

  if (useAbbrev) {
    const abs = Math.abs(num);
    if (abs >= 1e8) {
      return `¥${(num / 1e8).toFixed(dec)}亿`;
    }
    if (abs >= 1e4) {
      return `¥${(num / 1e4).toFixed(dec)}万`;
    }
  }

  if (useThousands) {
    return `¥${num.toLocaleString('zh-CN', {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    })}`;
  }
  return `¥${num.toFixed(dec)}`;
}

/**
 * 计算 XIRR 环比变化（单位：百分点），返回带正负号字符串。
 */
export function formatChange(
  current: number | null | undefined,
  previous: number | null | undefined,
  digits = 2,
): string {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return '-';
  }
  const diff = (current - previous) * 100;
  if (!Number.isFinite(diff)) return '-';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(digits)}pp`;
}

/**
 * 格式化「金额差异 + 差异%」：`+¥9,000.00 (+3.20%)` / `-¥1,000.00 (-0.35%)`。
 *
 * 用于资产记录页手工行差异列、差异提示条、表单覆盖提示（PRD §7.3 / SNAP-P0-04b ⑥）。
 * - current = 当前（手工）值；base = 基准（系统自动计算值）
 * - 任一为 null / 非有限数 / base 为 0 → 返回 '-'（差异率无意义，避免除零）
 * - 金额沿用 formatCurrency 口径（含 ¥ 前缀、千分位、2 位小数）
 * - options 透传给内部 formatCurrency（thousands / abbreviate / decimals）
 */
export function formatAmountChange(
  current: number | string | null | undefined,
  base: number | string | null | undefined,
  digits = 2,
  options?: FormatCurrencyOptions,
): string {
  if (
    current === null ||
    current === undefined ||
    current === '' ||
    base === null ||
    base === undefined ||
    base === ''
  ) {
    return '-';
  }
  const cur = typeof current === 'string' ? Number(current) : current;
  const b = typeof base === 'string' ? Number(base) : base;
  if (!Number.isFinite(cur) || !Number.isFinite(b) || b === 0) return '-';
  const diff = cur - b;
  const rate = diff / b;
  const sign = diff > 0 ? '+' : '';
  // 百分比同样带正负号：正数 (+3.20%)，负数 (-0.36%)（PRD §7.3 口径）
  const rateSign = rate > 0 ? '+' : '';
  return `${sign}${formatCurrency(diff, digits, options)} (${rateSign}${(rate * 100).toFixed(digits)}%)`;
}

/** 手工记录差异统计结果（SNAP-P0-07 顶部常驻提示条） */
export interface ManualDiffStats {
  /** 手工记录条数 N */
  manualCount: number;
  /** 与自动值差异率 > threshold 的手工条数 M（默认 >1%，即 Math.abs(diffRate) > 0.01） */
  diffOverThresholdCount: number;
}

/**
 * 统计列表中的手工记录条数 N 与「差异 > 阈值」条数 M。
 *
 * 供资产记录页差异提示条「当前有 N 条手工记录，其中 M 条与自动值差异 > 1%」使用。
 * 口径：source === 'MANUAL' 计入 N；系统值存在且 |(手工-系统)/系统| > threshold 计入 M。
 * 系统值取后端 `derivedTotalAsset`（AL-054 · 决策 Q-1甲，实时回填，非 NAV×份额近似）。
 *
 * @param items 快照行（可为当前页列表；分页场景统计口径为当前页，注释见调用处）
 * @param systemValueMap date → 系统自动计算值 映射（取自各行 derivedTotalAsset）
 * @param threshold 差异率阈值，默认 0.01（Part E-2）
 */
export function computeManualDiffStats(
  items: ReadonlyArray<{
    date: string;
    totalAsset?: string | number | null;
    source: string;
  }>,
  systemValueMap: ReadonlyMap<string, number> | null | undefined,
  threshold = 0.01,
): ManualDiffStats {
  let manualCount = 0;
  let diffOverThresholdCount = 0;
  for (const item of items) {
    if (item.source !== 'MANUAL') continue;
    manualCount += 1;
    const systemVal = systemValueMap?.get(item.date);
    const totalAssetNum = Number(item.totalAsset);
    if (
      systemVal !== undefined &&
      Number.isFinite(systemVal) &&
      systemVal !== 0 &&
      Number.isFinite(totalAssetNum)
    ) {
      const diffRate = (totalAssetNum - systemVal) / systemVal;
      if (Math.abs(diffRate) > threshold) {
        diffOverThresholdCount += 1;
      }
    }
  }
  return { manualCount, diffOverThresholdCount };
}
