/**
 * components/charts/monthly-heatmap.ts — 月度收益热力图纯函数测试
 *
 * 平移自 React 版 web/src/components/charts/__tests__/monthly-heatmap.test.tsx。
 * 直接对 computeMonthlyReturns + buildMonthlyHeatmapOption 单测（不挂载、不依赖
 * Canvas），覆盖月份轴恒定、有/无数据月份着色、年内首月基准、跨年基准、月份键
 * 补零、正红负绿色阶、tooltip 映射、空数据兜底。
 */

import { describe, expect, it } from 'vitest';
import {
  buildMonthlyHeatmapOption,
  computeMonthlyReturns,
  HEATMAP_MONTHS,
} from '@/components/charts/monthly-heatmap';
import type { NavSeriesPoint } from '@/lib/types';

/** 构造某月最后一个自然日的净值点 */
function navPoint(date: string, yearNav: number | null): NavSeriesPoint {
  return { date, yearNav } as NavSeriesPoint;
}

const ALL_MONTH_LABELS = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];

describe('MonthlyHeatmap — 月份轴恒定 1–12', () => {
  it('只有 8 月有数据时，X 轴仍输出完整 1–12 月且标签不抽稀', () => {
    const { years, cells } = computeMonthlyReturns([
      navPoint('2025-08-01', 1.0),
      navPoint('2025-08-29', 1.08),
    ]);
    const option = buildMonthlyHeatmapOption({ years, cells });

    expect(option.xAxis).toBeDefined();
    expect((option.xAxis as any).type).toBe('category');
    expect((option.xAxis as any).data).toEqual(ALL_MONTH_LABELS);
    expect((option.xAxis as any).axisLabel.interval).toBe(0);
    expect((option.yAxis as any).data).toEqual(['2025']);
  });

  it('有数据月份着色、无数据月份留空：series 只含有数据的 (x,y)', () => {
    const { years, cells } = computeMonthlyReturns([navPoint('2025-08-29', 1.08)]);
    const option = buildMonthlyHeatmapOption({ years, cells });

    const [series] = option.series as any[];
    expect(series.type).toBe('heatmap');
    expect(series.data).toHaveLength(1);
    const [x, y, v] = series.data[0];
    expect(x).toBe(7);
    expect(y).toBe(0);
    expect(typeof v).toBe('number');
    expect(v as number).toBeCloseTo(0.08, 10);
  });

  it('同年多月：逐月环比，10/11/12 月不因字典序错位', () => {
    const { years, cells } = computeMonthlyReturns([
      navPoint('2025-02-28', 1.02),
      navPoint('2025-10-31', 1.1),
      navPoint('2025-11-30', 1.05),
      navPoint('2025-12-31', 1.2),
    ]);
    const option = buildMonthlyHeatmapOption({ years, cells });

    const [series] = option.series as any[];
    const byMonth = new Map<number, number | string>(series.data.map(([x, , v]: [number, number, number | string]) => [x + 1, v]));
    expect(byMonth.get(2) as number).toBeCloseTo(0.02, 10);
    expect(byMonth.get(10) as number).toBeCloseTo(0.08, 10);
    expect(byMonth.get(11) as number).toBeCloseTo(-0.05, 10);
    expect(byMonth.get(12) as number).toBeCloseTo(0.15, 10);
  });

  it('跨年：次年 1 月以年初基准 1.0 计算，不拿上一年 12 月 year_nav 当基准', () => {
    const { years, cells } = computeMonthlyReturns([
      navPoint('2024-12-31', 1.3),
      navPoint('2025-01-31', 1.04),
    ]);
    const option = buildMonthlyHeatmapOption({ years, cells });

    expect((option.yAxis as any).data).toEqual(['2024', '2025']);

    const [series] = option.series as any[];
    const cell2025Jan = series.data.find(([x, y]: [number, number, number | string]) => x === 0 && y === 1);
    expect(cell2025Jan).toBeTruthy();
    expect(cell2025Jan?.[2] as number).toBeCloseTo(0.04, 10);
  });

  it('tooltip 按恒定月份轴映射月份，null 值提示「数据不足」', () => {
    const { years, cells } = computeMonthlyReturns([
      navPoint('2025-03-31', 1.05),
      navPoint('2025-04-30', null),
    ]);
    const option = buildMonthlyHeatmapOption({ years, cells });

    const tooltip = (option.tooltip as any).formatter;
    expect(tooltip({ value: [2, 0, 0.05] })).toContain('2025年 3月');
    expect(tooltip({ value: [2, 0, 0.05] })).toContain('5.00%');
    expect(tooltip({ value: [3, 0, '-'] })).toContain('数据不足');
  });

  it('正红负绿色阶保留：visualMap 首色=跌色、末色=涨色（PRD §9.5 国内习惯）', () => {
    const { years, cells } = computeMonthlyReturns([navPoint('2025-08-29', 1.08)]);
    const option = buildMonthlyHeatmapOption({ years, cells });

    const { color } = (option.visualMap as any).inRange;
    expect(color).toHaveLength(7);
    expect(color[0]).toMatch(/^hsl\(/);
    expect(color[color.length - 1]).toMatch(/^hsl\(/);
    expect(color.slice(1, 6)).toEqual([
      '#22c55e',
      '#86efac',
      '#fde68a',
      '#fca5a5',
      '#f87171',
    ]);
  });

  it('空数据 → 兜底为 years/cells 空，不抛错', () => {
    const { years, cells } = computeMonthlyReturns([]);
    expect(years).toEqual([]);
    expect(cells).toEqual([]);
    expect(() => buildMonthlyHeatmapOption({ years, cells })).not.toThrow();
  });

  it('HEATMAP_MONTHS 恒为 1–12', () => {
    expect(Array.from(HEATMAP_MONTHS)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
