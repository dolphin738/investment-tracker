/**
 * components/charts/xirr-trend-chart.ts — XIRR 趋势折线图 option 纯函数
 *
 * 平移自 React 版 web/src/components/charts/xirr-trend-chart.tsx
 * （useMemo 内的 option 构造抽为纯函数，便于单测；组件见 XirrTrendChart.vue）。
 *
 * 展示累计 XIRR 随时间变化趋势。
 */

import type { EChartsOption } from 'echarts';
import { chartGrid } from '@/components/charts/chart-grid';
import { getChartTheme, type ChartTheme } from '@/lib/chart-theme';
import type { XirrSeriesPoint } from '@/lib/types';
import {
  type AxisTooltipParam,
  TOOLTIP_EXTRA_CSS_TEXT,
  axisSplitLine,
  formatPercentAxisTooltip,
} from '@/components/charts/chart-tooltip';

/** option 构造入参 */
export interface XirrTrendOptionInput {
  /** XIRR 序列（null/undefined 由纯函数兜底为空数组） */
  data: XirrSeriesPoint[] | null | undefined;
  /**
   * null 数据点是否连线。
   * 默认 true（历史行为，保持测试契约）；
   * PRD §7.5 要求「null 断线不画 0」时传 false。
   */
  connectNulls?: boolean;
  /** 图表主题配色；不传则由 getChartTheme() 读取当前 CSS 变量（暗色跟随） */
  theme?: ChartTheme;
}

/** 构建 XIRR 趋势折线图 option（与 React 版 useMemo 内构造逐字一致） */
export function buildXirrTrendOption(
  input: XirrTrendOptionInput,
): EChartsOption {
  const { data, connectNulls = true } = input;
  // 兜底 undefined/null，否则组件在 data 缺省时抛错、空态分支永不可达
  const points: XirrSeriesPoint[] = data ?? [];
  const labels: string[] = points.map((d) => d.label);
  const values: (number | null)[] = points.map((d) => d.xirrValue);
  const connect = connectNulls;
  const theme = input.theme ?? getChartTheme();

  return {
    tooltip: {
      trigger: 'axis',
      // 背景/边框交给 extraCssText（tooltip 为 DOM，CSS 变量由浏览器解析，可跟随主题）
      backgroundColor: 'transparent',
      borderWidth: 0,
      padding: 0,
      textStyle: { fontSize: 12 },
      extraCssText: TOOLTIP_EXTRA_CSS_TEXT,
      formatter: formatPercentAxisTooltip,
    },
    // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切（问题①）
    grid: chartGrid({ bottom: 5 }),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLabel: { fontSize: 12, color: theme.axis },
      // ECharts category 轴默认无 splitLine，需显式开启才等价于迁移前的双向网格
      splitLine: axisSplitLine(theme.grid),
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        fontSize: 12,
        color: theme.axis,
        formatter: (v: number): string => `${(v * 100).toFixed(0)}%`,
      },
      splitLine: axisSplitLine(theme.grid),
    },
    series: [
      {
        name: 'XIRR',
        type: 'line',
        smooth: true,
        connectNulls: connect,
        showSymbol: false,
        symbolSize: 8, // 直径 8 = 半径 4，对应迁移前 activeDot={{ r: 4 }}
        emphasis: { scale: false }, // 关闭 hover 额外放大，锁死 r=4
        lineStyle: { width: 2, color: theme.line },
        itemStyle: { color: theme.line },
        data: values,
      },
    ],
  };
}
