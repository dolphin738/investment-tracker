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
import { formatPercent } from '@/lib/utils';
import type { XirrSeriesPoint } from '@/lib/types';

/**
 * 颜色常量。
 * 注意：必须使用「逗号分隔」的 hsl 语法 —— ECharts/zrender 的颜色解析器不支持
 * CSS Color Level 4 的空格语法 `hsl(217 91% 60%)`（静默解析失败返回 null）。
 */
const COLOR_XIRR = 'hsl(217, 91%, 60%)'; // ≈ #3b82f6，与迁移前数值一致
/** 网格线色：与迁移前实际渲染色一致（class 未生效，实渲染为 #ccc） */
const GRID_COLOR = '#ccc';
/** 轴标签色：与迁移前实际渲染色一致（tick 自带 fill="#666"） */
const AXIS_COLOR = '#666';

/** ECharts `trigger: 'axis'` tooltip 回调入参（仅声明本组件用到的字段） */
interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | string | null;
  dataIndex: number;
}

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

  return {
    tooltip: {
      trigger: 'axis',
      // 背景/边框交给 extraCssText（tooltip 为 DOM，CSS 变量由浏览器解析，可跟随主题）
      backgroundColor: 'transparent',
      borderWidth: 0,
      padding: 0,
      textStyle: { fontSize: 12 },
      extraCssText:
        'background: hsl(var(--popover));' +
        'border: 1px solid hsl(var(--border));' +
        'border-radius: 6px;' +
        'color: hsl(var(--popover-foreground));' +
        'padding: 8px 12px;' +
        'box-shadow: none;',
      formatter: (params: unknown): string => {
        // echarts 的 TopLevelFormatterParams 派生自 CallbackDataParams，
        // 此处用 unknown 承接后收窄为本组件只关心的字段（避免 marker 联合类型冲突）
        const arr = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
        const p = arr[0];
        if (!p) return '';
        const v = p.value;
        // null / undefined 必须在调用 formatPercent 前拦截（其空值兜底返回 '-'，非「数据不足」）
        const text = v === null || v === undefined ? '数据不足' : formatPercent(Number(v));
        return `${p.axisValueLabel ?? ''}<br/>${p.marker ?? ''}XIRR: ${text}`;
      },
    },
    // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切（问题①）
    grid: chartGrid({ bottom: 5 }),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLabel: { fontSize: 12, color: AXIS_COLOR },
      // ECharts category 轴默认无 splitLine，需显式开启才等价于迁移前的双向网格
      splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        fontSize: 12,
        color: AXIS_COLOR,
        formatter: (v: number): string => `${(v * 100).toFixed(0)}%`,
      },
      splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
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
        lineStyle: { width: 2, color: COLOR_XIRR },
        itemStyle: { color: COLOR_XIRR },
        data: values,
      },
    ],
  };
}
