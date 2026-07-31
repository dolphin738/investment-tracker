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
 * 将小数形式百分比（0.1234）格式化为 "12.34%"。
 * 输入 null 时返回 '-'。
 * digits 保留小数位数，默认 2。
 */
export function formatPercent(
  value: number | string | null | undefined,
  digits = 2,
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '-';
  return `${(num * 100).toFixed(digits)}%`;
}

/**
 * 格式化净值/小数（默认 4 位小数）。
 */
export function formatDecimal(
  value: number | string | null | undefined,
  digits = 4,
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '-';
  return num.toFixed(digits);
}

/**
 * 格式化金额（2 位小数，千分位）。
 */
export function formatCurrency(
  value: number | string | null | undefined,
  digits = 2,
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
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
