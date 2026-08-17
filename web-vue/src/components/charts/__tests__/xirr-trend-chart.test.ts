/**
 * components/charts/xirr-trend-chart.ts — XIRR 趋势折线图 option 纯函数测试
 *
 * 平移自 React 版 web/src/components/charts/__tests__/xirr-trend-chart.test.tsx。
 * 直接对 buildXirrTrendOption 单测（不挂载、不依赖 Canvas），覆盖三态对应的
 * option 结构 + tooltip 分支。
 */

import { describe, expect, it } from 'vitest';
import { buildXirrTrendOption } from '@/components/charts/xirr-trend-chart';
import type { XirrSeriesPoint } from '@/lib/types';

interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | string | null;
  dataIndex: number;
}

const XIRR_DATA: XirrSeriesPoint[] = [
  { date: '2024-01-31', label: '2024-01', xirrValue: 0.0821 },
  { date: '2024-02-29', label: '2024-02', xirrValue: null },
  { date: '2024-03-31', label: '2024-03', xirrValue: -0.0345 },
] as XirrSeriesPoint[];

describe('buildXirrTrendOption — 三态对应 option 结构', () => {
  it('正常数据（含 null 点）：axis 贴边、单线、null 原样保留、connectNulls', () => {
    const option = buildXirrTrendOption({ data: XIRR_DATA });

    expect(option.xAxis).toBeDefined();
    expect((option.xAxis as any).type).toBe('category');
    expect((option.xAxis as any).boundaryGap).toBe(false);
    expect((option.xAxis as any).data).toEqual(['2024-01', '2024-02', '2024-03']);

    expect(option.series).toHaveLength(1);
    const [line] = option.series as any[];
    expect(line?.type).toBe('line');
    expect(line?.name).toBe('XIRR');
    expect(line?.data).toEqual([0.0821, null, -0.0345]);
    expect(line?.connectNulls).toBe(true);
  });

  it('空数据 [] 与 undefined：兜底为空数组，不抛错', () => {
    const empty = buildXirrTrendOption({ data: [] });
    expect((empty.xAxis as any).data).toEqual([]);
    expect(empty.series).toHaveLength(1);

    const undef = buildXirrTrendOption({ data: undefined });
    expect((undef.xAxis as any).data).toEqual([]);
    expect(undef.series).toHaveLength(1);
  });

  it('tooltip 分支：null → 「数据不足」；正数 → formatPercent(2 位)；负数同理', () => {
    const option = buildXirrTrendOption({ data: XIRR_DATA });
    const formatter = (option.tooltip as any).formatter as (p: AxisTooltipParam[]) => string;

    const nullTooltip = formatter([
      { axisValueLabel: '2024-02', seriesName: 'XIRR', value: null, dataIndex: 1 },
    ]);
    expect(nullTooltip).toContain('数据不足');
    expect(nullTooltip).not.toContain('NaN');

    const positiveTooltip = formatter([
      { axisValueLabel: '2024-01', seriesName: 'XIRR', value: 0.0821, dataIndex: 0 },
    ]);
    expect(positiveTooltip).toContain('8.21%');

    const negativeTooltip = formatter([
      { axisValueLabel: '2024-03', seriesName: 'XIRR', value: -0.0345, dataIndex: 2 },
    ]);
    expect(negativeTooltip).toContain('-3.45%');
  });
});
