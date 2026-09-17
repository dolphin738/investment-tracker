/**
 * components/charts/dividend-yield-curve-chart.ts — 股息率双轴曲线图 option 纯函数测试
 *
 * 对齐 nav-trend-chart.test.ts 范式（不挂载组件、不依赖 Canvas），覆盖三态对应的
 * option 结构（双轴 / 双系列 / 高股息线 markLine）+ 双单位 tooltip + 主题配色 + 统一 grid。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDividendYieldCurveOption,
  HIGH_YIELD_PIVOT,
  type DividendYieldCurveOptionInput,
} from '@/components/charts/dividend-yield-curve-chart';
import { chartGrid } from '@/components/charts/chart-grid';
import type { DividendYieldCurveItem } from '@/api/types';

const CURVE_DATA: DividendYieldCurveItem[] = [
  { trade_date: '2025-09-01', close: 10, numerator_per_share: 0.5, dividend_yield: 0.05, mode: 'TTM' },
  { trade_date: '2025-10-01', close: 10, numerator_per_share: 0.5, dividend_yield: null, mode: 'TTM' },
  { trade_date: '2025-11-01', close: 10, numerator_per_share: 0.5, dividend_yield: 0.06, mode: 'TTM' },
];

describe('buildDividendYieldCurveOption — 三态对应 option 结构（双轴 / 双系列）', () => {
  it('正常数据（含 null 点）：双 yAxis、双 line 系列、百分比与收盘价分离、markLine 在左轴 5%', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });

    expect(option.xAxis).toBeDefined();
    expect((option.xAxis as any).type).toBe('category');
    expect((option.xAxis as any).data).toEqual([
      '2025-09-01',
      '2025-10-01',
      '2025-11-01',
    ]);

    // 双 yAxis：左 股息率(%) / 右 收盘价(¥)
    const yAxis = option.yAxis as any[];
    expect(Array.isArray(yAxis)).toBe(true);
    expect(yAxis).toHaveLength(2);
    expect(yAxis[0].axisLabel?.formatter).toBe('{value}%');
    expect(yAxis[1].axisLabel?.formatter).toBe('{value}');

    const series = option.series as any[];
    expect(series).toHaveLength(2);

    // 系列 0：股息率（左轴），0.05 → 5、null 保留、0.06 → 6
    expect(series[0]?.name).toBe('股息率');
    expect(series[0]?.type).toBe('line');
    expect(series[0]?.yAxisIndex).toBe(0);
    expect(series[0]?.connectNulls).toBe(false);
    expect(series[0]?.data).toEqual([5, null, 6]);

    // 系列 1：收盘价（右轴），原值 10
    expect(series[1]?.name).toBe('收盘价');
    expect(series[1]?.type).toBe('line');
    expect(series[1]?.yAxisIndex).toBe(1);
    expect(series[1]?.data).toEqual([10, 10, 10]);
  });

  it('空数据 [] 与 undefined：兜底空数组，仍双轴双系列结构', () => {
    const empty = buildDividendYieldCurveOption({ items: [] });
    expect((empty.xAxis as any).data).toEqual([]);
    expect(empty.series).toHaveLength(2);

    const undef = buildDividendYieldCurveOption({ items: undefined });
    expect((undef.xAxis as any).data).toEqual([]);
    expect(undef.series).toHaveLength(2);
  });

  it('高股息线参考线：落在左轴(yAxisIndex:0)的虚线 markLine，标签「高股息线 5%」且置于绘图区内左端', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    const series = option.series as any[];
    const ml = series[0]?.markLine;
    expect(ml).toBeDefined();
    expect(ml.data[0].yAxis).toBe(HIGH_YIELD_PIVOT);
    expect(ml.lineStyle?.type).toBe('dashed');
    expect(ml.label?.formatter).toBe(`高股息线 ${HIGH_YIELD_PIVOT}%`);
    expect(ml.label?.position).toBe('insideStart');
    // 左轴 max 必须为函数且 ≥5，防止数据峰值<5 时参考线被自动缩放裁掉
    const maxFn = (option.yAxis as any[])[0].max;
    expect(typeof maxFn).toBe('function');
    expect(maxFn({ min: 0, max: 3 })).toBeGreaterThanOrEqual(HIGH_YIELD_PIVOT);
  });

  it('pivotPercent 可覆盖参考线阈值（跟随全局设置）：线位 / 标签 / 轴顶兜底同步更新', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA, pivotPercent: 8 });
    const series = option.series as any[];
    const ml = series[0]?.markLine;
    expect(ml.data[0].yAxis).toBe(8);
    expect(ml.label?.formatter).toBe('高股息线 8%');
    const maxFn = (option.yAxis as any[])[0].max;
    expect(maxFn({ min: 0, max: 3 })).toBeGreaterThanOrEqual(8);
  });
});

describe('buildDividendYieldCurveOption — 双单位 tooltip', () => {
  it('formatter：股息率带 %、收盘价带 ¥，空值显示「数据不足」', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    const formatter = (option.tooltip as any).formatter as (p: unknown) => string;

    const out = formatter([
      { axisValueLabel: '2025-09-01', seriesName: '股息率', marker: '●', value: 5 },
      { axisValueLabel: '2025-09-01', seriesName: '收盘价', marker: '●', value: 10 },
    ]);
    expect(out).toContain('2025-09-01');
    expect(out).toContain('股息率: 5%');
    expect(out).toContain('收盘价: 10¥');

    const empty = formatter([
      { axisValueLabel: '2025-10-01', seriesName: '股息率', marker: '●', value: null },
    ]);
    expect(empty).toContain('数据不足');
  });
});

describe('buildDividendYieldCurveOption — 主题配色（P1 修复：不再硬编码 hsl(var(--primary))）', () => {
  it('传入 theme：两系列分别用 theme.line / theme.lineSecondary，左轴标签用 theme.axis', () => {
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

    expect(series[0]?.lineStyle?.color).toBe('hsl(217, 91%, 60%)'); // 股息率
    expect(series[1]?.lineStyle?.color).toBe('hsl(142, 71%, 45%)'); // 收盘价
    expect((option.yAxis as any[])[0].axisLabel?.color).toBe('hsl(215.4, 16.3%, 46.9%)');
  });

  it('不传 theme：回退 getChartTheme()，不出现 CSS 变量字符串（暗色发飘根因）', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    const series = option.series as any[];
    expect(JSON.stringify(option)).not.toContain('var(--primary)');
    expect(series[0]?.lineStyle?.color).toMatch(/^hsl\(/);
  });
});

describe('buildDividendYieldCurveOption — 统一 grid（双轴右留白放大）', () => {
  it('grid 由 chartGrid() 提供（right=56 容纳右轴标签），末位日期半宽仍由 chartGrid 保证', () => {
    const option = buildDividendYieldCurveOption({ items: CURVE_DATA });
    expect(option.grid).toEqual(chartGrid({ left: 44, right: 56, top: 36, bottom: 28 }));
    expect((option.grid as any).right).toBe(56);
  });
});
