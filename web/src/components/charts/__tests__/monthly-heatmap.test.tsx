/**
 * components/charts/monthly-heatmap.tsx — 月份轴恒定 1–12 回归测试
 *
 * 覆盖：
 * 1. 只有 8 月有数据 → X 轴仍完整输出 1月…12月（修复前只有「8月」一列）
 * 2. 有数据月份正常着色（rate 为数值），无数据月份不出现在 series（留空不着色）
 * 3. 年内首月以年初基准 1.0 计算，不再因缺少 prev 而恒为「数据不足」
 * 4. 跨年不再拿上一年 12 月 year_nav 作基准（year_nav 每年重置为 1.0）
 * 5. 月份键补零：10/11/12 月不会因字典序排到 2 月之前导致环比配对错位
 * 6. 正红负绿色阶保留（PRD §9.5，国内习惯）
 *
 * jsdom 无 Canvas，必须 mock `echarts-for-react`（架构增量设计 §7.6）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { NavSeriesPoint } from '@/lib/types';

const echartsSpy = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('echarts-for-react', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: { option: unknown }) => {
      echartsSpy.options.push(props.option);
      return createElement('div', {
        'data-testid': 'echarts-mock',
        'data-option': JSON.stringify(props.option),
      });
    },
  };
});

// 必须在 vi.mock 之后导入被测组件
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';

/** ECharts option 中本测试关心的字段 */
interface HeatmapOption {
  xAxis: { type: string; data: string[]; axisLabel: { interval: number } };
  yAxis: { data: string[] };
  visualMap: { min: number; max: number; inRange: { color: string[] } };
  series: { type: string; data: [number, number, number | string][] }[];
  tooltip: {
    formatter: (p: { value: [number, number, number | string] }) => string;
  };
}

function lastOption(): HeatmapOption {
  expect(echartsSpy.options.length).toBeGreaterThan(0);
  return echartsSpy.options[echartsSpy.options.length - 1] as HeatmapOption;
}

/** 构造某月最后一个自然日的净值点 */
function navPoint(date: string, yearNav: number | null): NavSeriesPoint {
  return { date, yearNav } as NavSeriesPoint;
}

const ALL_MONTH_LABELS = [
  '1月',
  '2月',
  '3月',
  '4月',
  '5月',
  '6月',
  '7月',
  '8月',
  '9月',
  '10月',
  '11月',
  '12月',
];

describe('MonthlyHeatmap — 月份轴恒定 1–12', () => {
  afterEach(() => {
    cleanup();
    echartsSpy.options.length = 0;
  });

  it('🔴 只有 8 月有数据时，X 轴仍输出完整 1–12 月且标签不抽稀', () => {
    render(
      <MonthlyHeatmap
        data={[navPoint('2025-08-01', 1.0), navPoint('2025-08-29', 1.08)]}
      />,
    );

    const option = lastOption();
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.data).toEqual(ALL_MONTH_LABELS);
    // interval: 0 → 12 个标签全部显示，不因宽度紧张被 ECharts 抽稀
    expect(option.xAxis.axisLabel.interval).toBe(0);
    // 年份轴仍由数据推导
    expect(option.yAxis.data).toEqual(['2025']);
  });

  it('🔴 有数据月份着色、无数据月份留空：series 只含有数据的 (x,y)', () => {
    render(
      <MonthlyHeatmap
        data={[navPoint('2025-08-29', 1.08)]}
      />,
    );

    const [series] = lastOption().series;
    expect(series.type).toBe('heatmap');
    // 只有 8 月一个格子（x=7），其余 11 个月不投点 → 渲染为空格
    expect(series.data).toHaveLength(1);
    const [x, y, v] = series.data[0];
    expect(x).toBe(7);
    expect(y).toBe(0);
    // 年内首月基准取年初 1.0 → 8% 且必须是数值（可着色），不是 '-'
    expect(typeof v).toBe('number');
    expect(v).toBeCloseTo(0.08, 10);
  });

  it('同年多月：逐月环比，10/11/12 月不因字典序错位', () => {
    render(
      <MonthlyHeatmap
        data={[
          navPoint('2025-02-28', 1.02),
          navPoint('2025-10-31', 1.1),
          navPoint('2025-11-30', 1.05),
          navPoint('2025-12-31', 1.2),
        ]}
      />,
    );

    const [series] = lastOption().series;
    const byMonth = new Map(series.data.map(([x, , v]) => [x + 1, v]));
    // 2 月：年内首月，基准 1.0 → +2%
    expect(byMonth.get(2) as number).toBeCloseTo(0.02, 10);
    // 10 月：上一有数据月为 2 月 → 1.10 - 1.02 = +8%
    expect(byMonth.get(10) as number).toBeCloseTo(0.08, 10);
    // 11 月：1.05 - 1.10 = -5%（若键未补零，10 月会排到 2 月前导致此值出错）
    expect(byMonth.get(11) as number).toBeCloseTo(-0.05, 10);
    // 12 月：1.20 - 1.05 = +15%
    expect(byMonth.get(12) as number).toBeCloseTo(0.15, 10);
  });

  it('🔴 跨年：次年 1 月以年初基准 1.0 计算，不拿上一年 12 月 year_nav 当基准', () => {
    render(
      <MonthlyHeatmap
        data={[navPoint('2024-12-31', 1.3), navPoint('2025-01-31', 1.04)]}
      />,
    );

    const option = lastOption();
    expect(option.yAxis.data).toEqual(['2024', '2025']);

    const [series] = option.series;
    const cell2025Jan = series.data.find(([x, y]) => x === 0 && y === 1);
    expect(cell2025Jan).toBeTruthy();
    // 正确值 +4%；旧实现会算成 1.04 - 1.30 = -26%
    expect(cell2025Jan?.[2] as number).toBeCloseTo(0.04, 10);
  });

  it('tooltip 按恒定月份轴映射月份，null 值提示「数据不足」', () => {
    render(
      <MonthlyHeatmap data={[navPoint('2025-03-31', 1.05), navPoint('2025-04-30', null)]} />,
    );

    const { tooltip } = lastOption();
    expect(tooltip.formatter({ value: [2, 0, 0.05] })).toContain('2025年 3月');
    expect(tooltip.formatter({ value: [2, 0, 0.05] })).toContain('5.00%');
    expect(tooltip.formatter({ value: [3, 0, '-'] })).toContain('数据不足');
  });

  it('正红负绿色阶保留：visualMap 首色=跌色、末色=涨色（PRD §9.5 国内习惯）', () => {
    render(<MonthlyHeatmap data={[navPoint('2025-08-29', 1.08)]} />);

    const { color } = lastOption().visualMap.inRange;
    // 首尾取自 CSS 变量 --color-down / --color-up；jsdom 下为空串亦保持顺序契约
    expect(color).toHaveLength(7);
    expect(color[0]).toMatch(/^hsl\(/);
    expect(color[color.length - 1]).toMatch(/^hsl\(/);
    // 中间渐变段保持「绿 → 黄 → 红」方向
    expect(color.slice(1, 6)).toEqual([
      '#22c55e',
      '#86efac',
      '#fde68a',
      '#fca5a5',
      '#f87171',
    ]);
  });

  it('空数据 → 「暂无数据」，不渲染图表', () => {
    const { container } = render(<MonthlyHeatmap data={[]} />);
    expect(container.textContent).toContain('暂无数据');
    expect(echartsSpy.options).toHaveLength(0);
  });
});
