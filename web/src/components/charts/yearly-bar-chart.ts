/**
 * components/charts/yearly-bar-chart.ts — 年度收益柱状图 option 纯函数
 *
 * 平移自 React 版 web/src/components/charts/yearly-bar-chart.tsx
 * （useMemo 内的 option 构造抽为纯函数，便于单测；组件见 YearlyBarChart.vue）。
 *
 * 输入 XirrSeriesPoint[]（按年聚合），展示各年度收益率对比柱状图（正红负绿）。
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

/** 当年柱高亮色（比基准色更深，红色系 / 绿色系保持不变） */
const HIGHLIGHT_POSITIVE_COLOR = 'hsl(0, 72%, 35%)';
const HIGHLIGHT_NEGATIVE_COLOR = 'hsl(142, 60%, 26%)';
/** 空值柱颜色：中性灰，与单测契约锁定的 #94a3b8 保持一致（非语义主题色，保留 hex） */
const MUTED_COLOR = '#94a3b8';

/** ECharts itemStyle 颜色回调入参（仅声明本组件用到的字段） */
interface ItemStyleParam {
  dataIndex: number;
}

/** option 构造入参 */
export interface YearlyBarOptionInput {
  /** 按年聚合的 XIRR 序列（null/undefined 由纯函数兜底为空数组） */
  data: XirrSeriesPoint[] | null | undefined;
  /**
   * DASH-P1-05 验收 2：高亮当年柱（加深填充色形成视觉强调）。
   * 说明：ECharts itemStyle.borderColor/borderWidth 不支持回调（makeStyleMapper 原样透传函数，
   * 渲染期 stroke 会被赋成函数），故高亮采用「当年柱加深填充色」替代描边，成本低且不破坏
   * 逐柱着色回调（data 仍为 number[]，正红负绿语义保持）。
   */
  highlightCurrentYear?: boolean;
  /** 高亮目标年份（默认系统当前年） */
  currentYear?: number;
  /** 图表主题配色；不传则由 getChartTheme() 读取当前 CSS 变量（暗色跟随） */
  theme?: ChartTheme;
}

/** 构建年度柱状图 option（与 React 版 useMemo 内构造逐字一致） */
export function buildYearlyBarOption(input: YearlyBarOptionInput): EChartsOption {
  const { data, highlightCurrentYear = false, currentYear } = input;
  // 兜底 undefined/null，否则组件在 data 缺省时抛错、空态分支永不可达
  const points: XirrSeriesPoint[] = data ?? [];
  const labels: string[] = points.map((d) => d.label);
  const values: (number | null)[] = points.map((d) => d.xirrValue);
  const highlightYear = currentYear ?? new Date().getFullYear();
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
    // 右侧留白由 chart-grid 统一给足，避免末位标签被裁切（问题①）
    grid: chartGrid({ bottom: 5 }),
    xAxis: {
      type: 'category',
      boundaryGap: true,
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
        type: 'bar',
        data: values,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          // 逐柱着色：等价于迁移前的 <Cell fill={...} />；当年柱（可选）加深高亮
          color: (params: ItemStyleParam): string => {
            const v = points[params.dataIndex]?.xirrValue;
            // 该分支不可见（null 不绘制柱形），保留仅为语义完整
            if (v === null || v === undefined) return MUTED_COLOR;
            const positive = v >= 0;
            const isCurrentYear =
              highlightCurrentYear &&
              points[params.dataIndex]?.label === String(highlightYear);
            if (isCurrentYear) {
              return positive ? HIGHLIGHT_POSITIVE_COLOR : HIGHLIGHT_NEGATIVE_COLOR;
            }
            return positive ? theme.up : theme.down;
          },
        },
      },
    ],
  };
}
