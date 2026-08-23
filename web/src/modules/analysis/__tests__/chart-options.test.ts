/**
 * modules/analysis/__tests__/chart-options.test.ts — 图表 option 构造纯函数单测
 *
 * 覆盖（B12 批次验收）：
 * 1. buildXirrTrendOption：labels/values 映射、connectNulls 默认 true 与透传、
 *    tooltip formatter 数值转百分比 / null 显示「数据不足」
 * 2. buildNavTrendOption：metric 决定注册的 series（both 双线 / 单选单线）、
 *    connectNulls 透传
 * 3. buildYearlyBarOption：labels/values 映射、y 轴百分比格式化、
 *    逐柱着色回调（正 up / 负 down / 当年柱高亮加深）
 * 4. computeMonthlyReturns：年内首月以年初基准 1.0、次月取上月末环比、
 *    跨年首月基准重置
 */

import { describe, expect, it } from 'vitest';
import { buildXirrTrendOption } from '@/components/charts/xirr-trend-chart';
import { buildNavTrendOption } from '@/components/charts/nav-trend-chart';
import { buildYearlyBarOption } from '@/components/charts/yearly-bar-chart';
import { computeMonthlyReturns } from '@/components/charts/monthly-heatmap';
import { NavMetric } from '@/lib/types';
import type { NavSeriesPoint, XirrSeriesPoint } from '@/lib/types';

// ---------------------------------------------------------------------------
// EChartsOption 联合过宽，测试侧用 unknown 双跳收窄出所需形状
// ---------------------------------------------------------------------------

interface AnySeries {
  name?: string;
  connectNulls?: boolean;
  data?: unknown[];
  itemStyle?: { color?: (params: { dataIndex: number }) => string };
}

interface OptionShape {
  xAxis?: { data?: string[] };
  yAxis?: { axisLabel?: { formatter?: (v: number) => string } };
  tooltip?: { formatter?: (p: TooltipParamLike) => string };
  series?: AnySeries[];
}

/** tooltip 回调入参的最小形状（与各图内部声明的 AxisTooltipParam 对齐） */
interface TooltipParamLike {
  axisValueLabel?: string;
  marker?: string;
  value?: number | string | null;
}

function shape(option: unknown): OptionShape {
  return option as OptionShape;
}

describe('buildXirrTrendOption — XIRR 趋势折线 option', () => {
  const points: XirrSeriesPoint[] = [
    { date: '2026-01-31', label: '2026-01', xirrValue: 0.1 },
    { date: '2026-02-28', label: '2026-02', xirrValue: null },
    { date: '2026-03-31', label: '2026-03', xirrValue: 0.1234 },
  ];

  it('映射 labels/values，connectNulls 默认 true，tooltip null 点显示「数据不足」', () => {
    const option = shape(buildXirrTrendOption({ data: points }));
    const [series] = option.series!;
    expect(series!.data).toEqual([0.1, null, 0.1234]);
    expect(series!.connectNulls).toBe(true);
    expect(option.xAxis!.data).toEqual(['2026-01', '2026-02', '2026-03']);
    // tooltip：数值点转百分比
    expect(
      option.tooltip!.formatter!({ axisValueLabel: '2026-03', value: 0.1234 }),
    ).toContain('XIRR: 12.34%');
    // tooltip：null 点显示「数据不足」（null 断线不画 0）
    expect(
      option.tooltip!.formatter!({ axisValueLabel: '2026-02', value: null }),
    ).toContain('XIRR: 数据不足');
  });

  it('connectNulls=false 透传（PRD §7.5 null 断线）', () => {
    const option = shape(buildXirrTrendOption({ data: points, connectNulls: false }));
    expect(option.series![0]!.connectNulls).toBe(false);
  });

  it('data 为 null/undefined 时兜底空数组（空态分支可达）', () => {
    for (const empty of [null, undefined]) {
      const option = shape(buildXirrTrendOption({ data: empty }));
      expect(option.xAxis!.data).toEqual([]);
      expect(option.series![0]!.data).toEqual([]);
    }
  });
});

describe('buildNavTrendOption — 净值趋势双线 option', () => {
  const points: NavSeriesPoint[] = [
    {
      date: '2026-01-31',
      label: '2026-01',
      cumulativeNav: 1.05,
      yearNav: 0.05,
      shares: 1000,
    },
    {
      date: '2026-02-28',
      label: '2026-02',
      cumulativeNav: null,
      yearNav: null,
      shares: 1000,
    },
  ];

  it('metric=both（缺省）注册「累计净值 + 当年净值」双 series，数据含 null', () => {
    const option = shape(buildNavTrendOption({ data: points }));
    expect(option.series!.map((s) => s.name)).toEqual(['累计净值', '当年净值']);
    expect(option.series![0]!.data).toEqual([1.05, null]);
    expect(option.series![0]!.connectNulls).toBe(true);
  });

  it('metric=cumulative / year 只注册所选的单条 series', () => {
    const cumulativeOnly = shape(
      buildNavTrendOption({ data: points, metric: NavMetric.CUMULATIVE }),
    );
    expect(cumulativeOnly.series!.map((s) => s.name)).toEqual(['累计净值']);

    const yearOnly = shape(
      buildNavTrendOption({ data: points, metric: NavMetric.YEAR }),
    );
    expect(yearOnly.series!.map((s) => s.name)).toEqual(['当年净值']);
  });

  it('connectNulls=false 透传到全部 series', () => {
    const option = shape(buildNavTrendOption({ data: points, connectNulls: false }));
    for (const s of option.series!) {
      expect(s.connectNulls).toBe(false);
    }
  });
});

describe('buildYearlyBarOption — 年度柱状图 option', () => {
  const points: XirrSeriesPoint[] = [
    { date: '2024-12-31', label: '2024', xirrValue: -0.05 },
    { date: '2025-12-31', label: '2025', xirrValue: 0.08 },
  ];

  it('映射 labels/values，y 轴标签按百分比格式化', () => {
    const option = shape(buildYearlyBarOption({ data: points }));
    expect(option.series![0]!.data).toEqual([-0.05, 0.08]);
    expect(option.xAxis!.data).toEqual(['2024', '2025']);
    expect(option.yAxis!.axisLabel!.formatter!(0.12)).toBe('12%');
  });

  it('逐柱着色：正值 up 色、负值 down 色、当年柱高亮加深', () => {
    const option = shape(
      buildYearlyBarOption({
        data: points,
        highlightCurrentYear: true,
        currentYear: 2025,
      }),
    );
    const color = option.series![0]!.itemStyle!.color!;
    // jsdom 无 CSS 变量，getChartTheme 兜底 FALLBACK '0 84% 48%' / '142 71% 38%'
    expect(color({ dataIndex: 0 })).toBe('hsl(142, 71%, 38%)'); // 负值 → down 绿
    expect(color({ dataIndex: 1 })).toBe('hsl(0, 72%, 35%)'); // 当年正柱 → 高亮深红
  });
});

describe('computeMonthlyReturns — 月度收益率聚合', () => {
  function navPoint(date: string, yearNav: number | null): NavSeriesPoint {
    return { date, label: date, cumulativeNav: null, yearNav, shares: null };
  }

  it('年内首月以年初基准 1.0，次月取上月末环比，跨年首月基准重置', () => {
    // 2025-01 月末 yearNav=1.10（相对年初 1.0 → +10%）
    // 2025-02 月末 yearNav=1.21（相对 1.10 → +11%）
    // 2026-01 月末 yearNav=0.95（跨年重置，相对 1.0 → -5%）
    const data = [
      navPoint('2025-01-20', 1.08), // 月内非末日，被末日覆盖
      navPoint('2025-01-31', 1.1),
      navPoint('2025-02-28', 1.21),
      navPoint('2026-01-31', 0.95),
    ];
    const { years, cells } = computeMonthlyReturns(data);

    expect(years).toEqual([2025, 2026]);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ year: 2025, month: 1 });
    expect(cells[0]!.rate).toBeCloseTo(0.1, 10);
    expect(cells[1]).toMatchObject({ year: 2025, month: 2 });
    expect(cells[1]!.rate).toBeCloseTo(0.11, 10);
    expect(cells[2]).toMatchObject({ year: 2026, month: 1 });
    expect(cells[2]!.rate).toBeCloseTo(-0.05, 10);
  });

  it('空输入返回空年份与空单元格', () => {
    expect(computeMonthlyReturns([])).toEqual({ years: [], cells: [] });
  });

  it('月末 yearNav 为 null 时该格 rate 为 null（数据不足不着色）', () => {
    const data = [navPoint('2025-01-31', null)];
    const { cells } = computeMonthlyReturns(data);
    expect(cells).toEqual([{ year: 2025, month: 1, rate: null }]);
  });
});
