/**
 * components/charts/nav-trend-chart.ts — 净值趋势双线图 option 纯函数测试
 *
 * 平移自 React 版 web/src/components/charts/__tests__/nav-trend-chart.test.tsx。
 * 因 Vue 侧已把 option 构造抽为纯函数 buildNavTrendOption，直接对其单测，
 * 与 chart-grid.test.ts 同范式（不挂载组件、不依赖 Canvas），覆盖三态对应的
 * option 结构 + metric 只渲染所选系列 + tooltip 分支。
 */

import { describe, expect, it } from 'vitest';
import { buildNavTrendOption } from '@/components/charts/nav-trend-chart';
import { NavMetric } from '@/lib/types';
import type { NavSeriesPoint } from '@/lib/types';

interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | string | null;
  dataIndex: number;
}

const NAV_DATA: NavSeriesPoint[] = [
  { date: '2024-01-31', label: '2024-01', cumulativeNav: 1.0, yearNav: 1.0, shares: 1000 },
  { date: '2024-02-29', label: '2024-02', cumulativeNav: null, yearNav: null, shares: null },
  { date: '2024-03-31', label: '2024-03', cumulativeNav: 1.0512, yearNav: 1.0512, shares: 1200 },
] as NavSeriesPoint[];

describe('buildNavTrendOption — 三态对应 option 结构', () => {
  it('正常数据（含 null 点）：axis 恒定、双线、null 原样保留、connectNulls', () => {
    const option = buildNavTrendOption({ data: NAV_DATA });

    expect(option.xAxis).toBeDefined();
    expect((option.xAxis as any).type).toBe('category');
    expect((option.xAxis as any).data).toEqual(['2024-01', '2024-02', '2024-03']);

    expect(option.series).toHaveLength(2);
    const [cumulative, year] = option.series as any[];
    expect(cumulative?.name).toBe('累计净值');
    expect(year?.name).toBe('当年净值');

    expect(cumulative?.data).toEqual([1.0, null, 1.0512]);
    expect(year?.data).toEqual([1.0, null, 1.0512]);
    expect(cumulative?.connectNulls).toBe(true);
    expect(year?.connectNulls).toBe(true);
  });

  it('空数据 [] 与 undefined：兜底为空数组，不抛错、series 仍双线结构', () => {
    const empty = buildNavTrendOption({ data: [] });
    expect((empty.xAxis as any).data).toEqual([]);
    expect(empty.series).toHaveLength(2);

    const undef = buildNavTrendOption({ data: undefined });
    expect((undef.xAxis as any).data).toEqual([]);
    expect(undef.series).toHaveLength(2);
  });

  it('tooltip 分支：null → 「数据不足」；数值 → formatDecimal(4 位)', () => {
    const option = buildNavTrendOption({ data: NAV_DATA });
    const formatter = (option.tooltip as any).formatter as (
      p: AxisTooltipParam[],
    ) => string;

    const nullTooltip = formatter([
      { axisValueLabel: '2024-02', seriesName: '累计净值', value: null, dataIndex: 1 },
      { axisValueLabel: '2024-02', seriesName: '当年净值', value: null, dataIndex: 1 },
    ]);
    expect(nullTooltip).toContain('数据不足');
    expect(nullTooltip).not.toContain('NaN');

    const valueTooltip = formatter([
      { axisValueLabel: '2024-03', seriesName: '累计净值', value: 1.0512, dataIndex: 2 },
    ]);
    expect(valueTooltip).toContain('1.0512');
    expect(valueTooltip).not.toContain('数据不足');
  });
});

describe('buildNavTrendOption — metric 只渲染所选系列（问题④）', () => {
  it('metric 缺省 = both：双线（向后兼容既有调用方）', () => {
    const option = buildNavTrendOption({ data: NAV_DATA });
    expect(option.series).toHaveLength(2);
    expect((option.series as any[]).map((s) => s.name)).toEqual(['累计净值', '当年净值']);
  });

  it('metric=both 显式传入：与缺省一致', () => {
    const option = buildNavTrendOption({ data: NAV_DATA, metric: NavMetric.BOTH });
    expect(option.series).toHaveLength(2);
  });

  it('metric=cumulative：只注册「累计净值」一条 series', () => {
    const option = buildNavTrendOption({ data: NAV_DATA, metric: NavMetric.CUMULATIVE });
    expect(option.series).toHaveLength(1);
    expect((option.series as any[])[0]?.name).toBe('累计净值');
    expect((option.series as any[])[0]?.data).toEqual([1.0, null, 1.0512]);
    expect(JSON.stringify(option.series)).not.toContain('当年净值');
  });

  it('metric=year：只注册「当年净值」一条 series', () => {
    const option = buildNavTrendOption({ data: NAV_DATA, metric: NavMetric.YEAR });
    expect(option.series).toHaveLength(1);
    expect((option.series as any[])[0]?.name).toBe('当年净值');
    expect((option.series as any[])[0]?.data).toEqual([1.0, null, 1.0512]);
    expect(JSON.stringify(option.series)).not.toContain('累计净值');
  });

  it('单指标下 tooltip 只有一行，不再出现恒为「数据不足」的另一指标', () => {
    const option = buildNavTrendOption({ data: NAV_DATA, metric: NavMetric.CUMULATIVE });
    const formatter = (option.tooltip as any).formatter as (p: AxisTooltipParam[]) => string;
    const tip = formatter([
      { axisValueLabel: '2024-02', seriesName: '累计净值', value: null, dataIndex: 1 },
    ]);
    expect(tip).toContain('数据不足');
    expect(tip).not.toContain('当年净值');
  });
});
