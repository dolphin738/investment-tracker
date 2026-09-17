/**
 * components/charts/dividend-yield-curve-chart.ts — 股息率曲线图 option 纯函数
 *
 * 双轴：左轴 股息率(%)、右轴 收盘价(¥)；两条 line+scatter 系列 + 高股息线
 * 虚线 markLine（参考线；阈值可配置，缺省 5%）。配色经 getChartTheme() 读取（跟随明暗主题），tooltip
 * 浮层样式复用 chart-tooltip 共享符号（CSS 变量跟随主题）。
 */

import type { EChartsOption } from 'echarts';
import { chartGrid } from '@/components/charts/chart-grid';
import {
  TOOLTIP_EXTRA_CSS_TEXT,
  axisSplitLine,
  type AxisTooltipParam,
} from '@/components/charts/chart-tooltip';
import { getChartTheme, type ChartTheme } from '@/lib/chart-theme';
import type { DividendYieldCurveItem } from '@/api/types';

/** option 构造入参 */
export interface DividendYieldCurveOptionInput {
  /** 曲线数据点（近一年股息率）；null/undefined 兜底为空数组 */
  items: DividendYieldCurveItem[] | null | undefined;
  /** 图表主题配色；不传则由 getChartTheme() 读取当前 CSS 变量（暗色跟随） */
  theme?: ChartTheme;
  /**
   * 高股息参考线的股息率阈值（百分数，如 5 表示 5%）。
   * 缺省用 HIGH_YIELD_PIVOT（5%）；由「设置 → 股息率」的 green_threshold 换算而来，
   * 使曲线参考线跟随全局阈值设置。
   */
  pivotPercent?: number;
}

/** 高股息线缺省阈值（股息率 %）；与后端 green_threshold 默认 0.05 一致，作兜底 */
export const HIGH_YIELD_PIVOT = 5;

/** 构建股息率双轴曲线图 option：左 股息率(%) / 右 收盘价(¥) + 高股息线虚线（阈值可配，缺省 5%） */
export function buildDividendYieldCurveOption(
  input: DividendYieldCurveOptionInput,
): EChartsOption {
  const points: DividendYieldCurveItem[] = input.items ?? [];
  const labels: string[] = points.map((d) => d.trade_date);
  // 股息率 → 百分数（0.05 → 5）；null 保留（缺段断开，§3.5/§7 缺失语义）
  const yields: (number | null)[] = points.map((d) =>
    d.dividend_yield !== null ? Number((d.dividend_yield * 100).toFixed(2)) : null,
  );
  // 收盘价 → 原值；null 保留
  const prices: (number | null)[] = points.map((d) =>
    d.close !== null ? Number(d.close) : null,
  );
  const theme = input.theme ?? getChartTheme();
  // 高股息参考线阈值（百分数）：优先用外部传入（跟随全局设置），缺省 5%
  const pivot = input.pivotPercent ?? HIGH_YIELD_PIVOT;

  return {
    color: [theme.line, theme.lineSecondary],
    tooltip: {
      trigger: 'axis',
      // 浮层样式交给 extraCssText（tooltip 为 DOM，CSS 变量由浏览器解析，跟随明暗主题）
      backgroundColor: 'transparent',
      borderWidth: 0,
      padding: 0,
      textStyle: { fontSize: 12 },
      extraCssText: TOOLTIP_EXTRA_CSS_TEXT,
      formatter: (params: unknown): string => {
        // echarts 的 TopLevelFormatterParams 派生自 CallbackDataParams，
        // 此处用 unknown 承接后收窄为本组件只关心的字段（避免 value 联合类型冲突）
        const arr = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
        const head: string = arr[0]?.axisValueLabel ?? '';
        const lines: string[] = arr.map((p) => {
          const v = p.value;
          // null / undefined 必须在拼接前拦截（否则 Number(null) === 0 误显 0）
          const text = v === null || v === undefined ? '数据不足' : `${Number(v)}`;
          // 两系列单位不同：股息率用 %、收盘价用 ¥
          const unit = p.seriesName === '股息率' ? '%' : '¥';
          return `${p.marker ?? ''}${p.seriesName ?? ''}: ${text}${unit}`;
        });
        return [head, ...lines].join('<br/>');
      },
    },
    legend: {
      top: 0,
      left: 'center',
      data: ['股息率', '收盘价'],
      textStyle: { color: theme.axis, fontSize: 11 },
    },
    // 双轴右侧需放下「收盘价(¥)」轴标签 → 右留白放大；末位日期标签半宽仍由 chartGrid 保证
    grid: chartGrid({ left: 44, right: 56, top: 36, bottom: 28 }),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLabel: { fontSize: 10, color: theme.axis },
      splitLine: axisSplitLine(theme.grid),
    },
    yAxis: [
      {
        type: 'value',
        name: '股息率(%)',
        nameTextStyle: { color: theme.axis, fontSize: 10 },
        axisLabel: { formatter: '{value}%', color: theme.axis },
        splitLine: axisSplitLine(theme.grid),
        // 兜底轴顶 ≥ 参考线阈值：避免数据峰值 < 阈值时自动缩放把参考线挤出可视区被裁掉
        max: (value: { min: number; max: number }) =>
          Math.max(pivot, Math.ceil(value.max)),
      },
      {
        type: 'value',
        name: '收盘价(¥)',
        nameTextStyle: { color: theme.axis, fontSize: 10 },
        axisLabel: { formatter: '{value}', color: theme.axis },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '股息率',
        type: 'line',
        yAxisIndex: 0,
        data: yields,
        connectNulls: false,
        // 直线段连接每日点（不平滑），使每个交易日成为显式顶点（参考图「散点按天」）
        smooth: false,
        symbolSize: 5,
        lineStyle: { width: 2, color: theme.line },
        itemStyle: { color: theme.line },
        // 高股息线参考线（虚线）：显式绑定左轴（股息率 %），标签置于绘图区内左端
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { type: 'dashed', color: theme.manual, width: 1 },
          label: {
            show: true,
            formatter: `高股息线 ${pivot}%`,
            position: 'insideStart',
            color: theme.manual,
            fontSize: 10,
          },
          data: [{ yAxis: pivot }],
        },
      },
      {
        name: '收盘价',
        type: 'line',
        yAxisIndex: 1,
        data: prices,
        connectNulls: false,
        smooth: false,
        symbolSize: 5,
        lineStyle: { width: 2, color: theme.lineSecondary },
        itemStyle: { color: theme.lineSecondary },
      },
    ],
  };
}
