/**
 * components/charts/dividend-yield-curve-chart.ts — 股息率曲线图 option 纯函数
 *
 * 平移自 modules/dividend-yield/components/SecurityDetailPanel.vue 内联的曲线 option
 * 构造（2026-09-08 审查收口：P2 抽出纯函数，对齐 nav-trend-chart.ts 范式，便于单测）。
 *
 * 近一年股息率曲线：股息率 → 百分数；缺段断开（connectNulls:false，§3.5/§7 缺失语义）。
 * 配色经 useChartTheme() 读取（跟随明暗主题），不再硬编码 hsl(var(--primary))。
 */

import type { EChartsOption } from 'echarts';
import { chartGrid } from '@/components/charts/chart-grid';
import { getChartTheme, type ChartTheme } from '@/lib/chart-theme';
import type { DividendYieldCurveItem } from '@/api/types';

/** option 构造入参 */
export interface DividendYieldCurveOptionInput {
  /** 曲线数据点（近一年股息率）；null/undefined 兜底为空数组 */
  items: DividendYieldCurveItem[] | null | undefined;
  /** 图表主题配色；不传则由 getChartTheme() 读取当前 CSS 变量（暗色跟随） */
  theme?: ChartTheme;
}

/** 构建股息率曲线图 option（与 SecurityDetailPanel 旧内联构造逐字一致，仅配色/grid 改走主题） */
export function buildDividendYieldCurveOption(
  input: DividendYieldCurveOptionInput,
): EChartsOption {
  const { items } = input;
  // 兜底 undefined/null，否则组件在 items 缺省时抛错、空态分支永不可达
  const points: DividendYieldCurveItem[] = items ?? [];
  const labels: string[] = points.map((d) => d.trade_date);
  const values: (number | null)[] = points.map((d) =>
    d.dividend_yield !== null
      ? Number((d.dividend_yield * 100).toFixed(2))
      : null,
  );
  const theme = input.theme ?? getChartTheme();

  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => `${v}%`,
    },
    // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切（对齐 TotalAssetTrendChart）
    grid: chartGrid(),
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 10, color: theme.axis },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: '{value}%', color: theme.axis },
    },
    series: [
      {
        type: 'line',
        data: values,
        connectNulls: false,
        smooth: true,
        symbolSize: 4,
        lineStyle: { width: 2, color: theme.line },
        itemStyle: { color: theme.line },
      },
    ],
  };
}
