/**
 * components/charts/dividend-yield-curve-chart.ts — 股息率曲线图 option 纯函数测试
 *
 * 对齐 nav-trend-chart.test.ts 范式（不挂载组件、不依赖 Canvas），覆盖三态对应的
 * option 结构 + 主题配色（P1 修复点）+ 统一 grid（P3）+ 百分比 tooltip。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDividendYieldCurveOption,
  type DividendYieldCurveOptionInput,
} from '@/components/charts/dividend-yield-curve-chart';
import { chartGrid } from '@/components/charts/chart-grid';
import type { DividendYieldCurveItem } from '@/api/types';

const CURVE_DATA: DividendYieldCurveItem[] = [
  { trade_date: '2025-09-01', close: 10, numerator_per_share: 0.5, dividend_yield: 0.05, mode: 'TTM' },
  { trade_date: '2025-10-01', close: 10, numerator_per_share: 0.5, dividend_yield: null, mode: 'TTM' },
  { trade_date: '2025-11-01', close: 10, numerator_per_share: 0.5, dividend_yield: 0.06, mode: 'TTM' },
];

describe('buildDividendYieldCurveOption — 三态对应 option 结构', () => {
  it('正常数据（含 null 点）：category 轴、单线、百分比、null 原样保留、connectNulls=false', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });

    expect(option.xAxis).toBeDefined();
    expect((option.xAxis as any).type).toBe('category');
    expect((option.xAxis as any).data).toEqual([
      '2025-09-01',
      '2025-10-01',
      '2025-11-01',
    ]);

    const series = option.series as any[];
    expect(series).toHaveLength(1);
    expect(series[0]?.type).toBe('line');
    expect(series[0]?.connectNulls).toBe(false);
    // 股息率 → 百分数（0.05 → 5, 0.06 → 6），null 保留
    expect(series[0]?.data).toEqual([5, null, 6]);
  });

  it('空数据 [] 与 undefined：兜底为空数组，不抛错、仍单线结构', () => {
    const empty = buildDividendYieldCurveOption({ items: [] });
    expect((empty.xAxis as any).data).toEqual([]);
    expect(empty.series).toHaveLength(1);

    const undef = buildDividendYieldCurveOption({ items: undefined });
    expect((undef.xAxis as any).data).toEqual([]);
    expect(undef.series).toHaveLength(1);
  });

  it('y 轴标签 %.formatter，tooltip valueFormatter 追加 %', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    expect((option.yAxis as any).axisLabel?.formatter).toBe('{value}%');

    const formatter = (option.tooltip as any).valueFormatter as (v: unknown) => string;
    expect(formatter(5)).toBe('5%');
    expect(formatter(null)).toBe('null%'); // 与旧内联构造逐字一致
  });
});

describe('buildDividendYieldCurveOption — 主题配色（P1 修复：不再硬编码 hsl(var(--primary))）', () => {
  it('传入 theme：折线 lineStyle/itemStyle 用 theme.line，轴标签用 theme.axis', () => {
    const input: DividendYieldCurveOptionInput = {
      items: CURVE_DATA,
      theme: {
        up: 'hsl(0, 84%, 48%)',
        down: 'hsl(142, 71%, 38%)',
        grid: 'hsl(214.3, 31.8%, 91.4%)',
        axis: 'hsl(215.4, 16.3%, 46.9%)',
        line: 'hsl(217, 91%, 60%)',
        lineSecondary: 'hsl(142, 71%, 45%)',
        manual: 'hsl(0, 84%, 48%)',
      },
    };
    const option = buildDividendYieldCurveOption(input);
    const series = option.series as any[];

    expect(series[0]?.lineStyle?.color).toBe('hsl(217, 91%, 60%)');
    expect(series[0]?.itemStyle?.color).toBe('hsl(217, 91%, 60%)');
    expect((option.xAxis as any).axisLabel?.color).toBe('hsl(215.4, 16.3%, 46.9%)');
    expect((option.yAxis as any).axisLabel?.color).toBe('hsl(215.4, 16.3%, 46.9%)');
  });

  it('不传 theme：回退 getChartTheme()，不出现 CSS 变量字符串（暗色发飘根因）', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    const series = option.series as any[];
    expect(JSON.stringify(option)).not.toContain('var(--primary)');
    expect(series[0]?.lineStyle?.color).toMatch(/^hsl\(/);
  });
});

describe('buildDividendYieldCurveOption — 统一 grid（P3）', () => {
  it('grid 由 chartGrid() 提供，right 留足末位标签半宽', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    expect(option.grid).toEqual(chartGrid());
    expect((option.grid as any).right).toBe(40);
  });
});
