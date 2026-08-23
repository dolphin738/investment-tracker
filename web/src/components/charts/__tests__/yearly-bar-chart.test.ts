/**
 * components/charts/yearly-bar-chart.ts — 年度收益柱状图 option 纯函数测试
 *
 * 平移自 React 版 web/src/components/charts/__tests__/yearly-bar-chart.test.tsx。
 * 直接对 buildYearlyBarOption 单测（不挂载、不依赖 Canvas），覆盖三态对应的
 * option 结构 + 逐柱着色回调（正/负/空）+ Tooltip 分支。
 */

import { describe, expect, it } from 'vitest';
import { buildYearlyBarOption } from '@/components/charts/yearly-bar-chart';
import type { XirrSeriesPoint } from '@/lib/types';

interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | string | null;
  dataIndex: number;
}

const YEARLY_DATA: XirrSeriesPoint[] = [
  { date: '2022-12-31', label: '2022', xirrValue: 0.1234 },
  { date: '2023-12-31', label: '2023', xirrValue: null },
  { date: '2024-12-31', label: '2024', xirrValue: -0.0567 },
] as XirrSeriesPoint[];

// 与组件内常量保持一致（PRD §9.5: 正红负绿）。getChartTheme 在 jsdom 下回退 FALLBACK 硬编码值。
const POSITIVE_COLOR = 'hsl(0, 84%, 48%)';
const NEGATIVE_COLOR = 'hsl(142, 71%, 38%)';
const MUTED_COLOR = '#94a3b8';

describe('buildYearlyBarOption — 三态对应 option 结构', () => {
  it('正常数据（含 null 点）：柱状图两端留白、null 原样保留、data 顺序一致', () => {
    const option = buildYearlyBarOption({ data: YEARLY_DATA });

    expect(option.xAxis).toBeDefined();
    expect((option.xAxis as any).type).toBe('category');
    expect((option.xAxis as any).boundaryGap).toBe(true);
    expect((option.xAxis as any).data).toEqual(['2022', '2023', '2024']);

    expect(option.series).toHaveLength(1);
    const [bar] = option.series as any[];
    expect(bar?.type).toBe('bar');
    expect(bar?.data).toEqual([0.1234, null, -0.0567]);
  });

  it('空数据 [] 与 undefined：兜底为空数组，不抛错', () => {
    const empty = buildYearlyBarOption({ data: [] });
    expect((empty.xAxis as any).data).toEqual([]);

    const undef = buildYearlyBarOption({ data: undefined });
    expect((undef.xAxis as any).data).toEqual([]);
  });

  it('逐柱着色回调：正→红（PRD §9.5: 正红负绿）、null→灰、负→绿、越界不抛', () => {
    const option = buildYearlyBarOption({ data: YEARLY_DATA });
    const [bar] = option.series as any[];
    const colorFn = bar?.itemStyle?.color;
    expect(typeof colorFn).toBe('function');
    if (typeof colorFn !== 'function') throw new Error('itemStyle.color 应为逐柱着色回调');

    expect(colorFn({ dataIndex: 0 })).toBe(POSITIVE_COLOR);
    expect(colorFn({ dataIndex: 1 })).toBe(MUTED_COLOR);
    expect(colorFn({ dataIndex: 2 })).toBe(NEGATIVE_COLOR);
    expect(() => colorFn({ dataIndex: 99 })).not.toThrow();
  });

  it('Tooltip 分支：null → 「数据不足」；正数 → formatPercent(2 位)；负数同理', () => {
    const option = buildYearlyBarOption({ data: YEARLY_DATA });
    const formatter = (option.tooltip as any).formatter as (p: AxisTooltipParam[]) => string;

    const nullTooltip = formatter([
      { axisValueLabel: '2023', seriesName: 'XIRR', value: null, dataIndex: 1 },
    ]);
    expect(nullTooltip).toContain('数据不足');
    expect(nullTooltip).not.toContain('NaN');

    const positiveTooltip = formatter([
      { axisValueLabel: '2022', seriesName: 'XIRR', value: 0.1234, dataIndex: 0 },
    ]);
    expect(positiveTooltip).toContain('12.34%');

    const negativeTooltip = formatter([
      { axisValueLabel: '2024', seriesName: 'XIRR', value: -0.0567, dataIndex: 2 },
    ]);
    expect(negativeTooltip).toContain('-5.67%');
  });
});
