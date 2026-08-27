/**
 * components/charts/chart-tooltip.ts — 图表 tooltip / 轴样式共享符号
 *
 * 归并 nav / xirr / yearly 三图逐字复制的 tooltip 入参类型、浮层样式、
 * 百分比轴标签与双向网格 splitLine（REP-031 / REP-032 / REP-033）。
 */

import { formatPercent } from '@/lib/utils';

/** ECharts `trigger: 'axis'` tooltip 回调入参（折线 / 散点 series 通用） */
export interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  /** 折线 series 是 number；散点 series 是 [走势点下标, 金额] 数组 */
  value?: number | string | [number, number] | null;
  dataIndex: number;
}

/** tooltip 浮层共享样式（CSS 变量跟随明暗主题，避免各图逐字复制） */
export const TOOLTIP_EXTRA_CSS_TEXT =
  'background: hsl(var(--popover));' +
  'border: 1px solid hsl(var(--border));' +
  'border-radius: 6px;' +
  'color: hsl(var(--popover-foreground));' +
  'padding: 8px 12px;' +
  'box-shadow: none;';

/** 百分比轴标签格式化（yAxis axisLabel，如 XIRR / 收益率轴） */
export function formatPercentAxisLabel(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

/** 双向网格 splitLine（category / value 轴通用；颜色随主题） */
export function axisSplitLine(color: string): {
  show: true;
  lineStyle: { type: [number, number]; color: string };
} {
  return { show: true, lineStyle: { type: [3, 3], color } };
}

/** XIRR 类图表 axis tooltip 完整文本（xirr / yearly 两图逐字一致） */
export function formatPercentAxisTooltip(params: unknown): string {
  const arr = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
  const p = arr[0];
  if (!p) return '';
  const v = p.value;
  // null / undefined 必须在调用 formatPercent 前拦截（其空值兜底返回 '-'，非「数据不足」）
  const text = v === null || v === undefined ? '数据不足' : formatPercent(Number(v));
  return `${p.axisValueLabel ?? ''}<br/>${p.marker ?? ''}XIRR: ${text}`;
}
