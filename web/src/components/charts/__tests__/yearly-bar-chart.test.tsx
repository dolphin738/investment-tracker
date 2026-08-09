/**
 * components/charts/yearly-bar-chart.tsx — 三态渲染冒烟测试（ECharts 迁移回归）
 *
 * 覆盖三态：
 * 1. loading=true       → Skeleton（h-[260px] w-full），图表不在 DOM
 * 2. data 空（[] / undefined） → 「暂无数据」，图表不在 DOM
 * 3. 正常数据（含 null 点） → 图表在 DOM、标题「年度 XIRR 对比」、
 *                              逐柱着色回调（正/负/空）正确、不抛错
 *
 * 关键约束（架构增量设计 §7.6）：
 * jsdom 无 Canvas，`echarts.init()` 会抛错，因此必须 mock `echarts-for-react`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { XirrSeriesPoint } from '@/lib/types';
import {
  CHART_MOCK_TESTID,
  expectChartState,
  expectEmptyState,
  expectLoadingState,
  lastOption,
  parseChartOption,
} from './chart-test-utils';

// ---------------------------------------------------------------------------
// echarts-for-react 替身（同其余图表测试，mock 必须按测试文件隔离）
// ---------------------------------------------------------------------------
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
import { YearlyBarChart } from '@/components/charts/yearly-bar-chart';

// ---------------------------------------------------------------------------
// 夹具：按年聚合的 XirrSeriesPoint（date 必填）
// 正 / 空 / 负三种柱，覆盖逐柱着色回调的全部分支
// ---------------------------------------------------------------------------
const YEARLY_DATA: XirrSeriesPoint[] = [
  { date: '2022-12-31', label: '2022', xirrValue: 0.1234 },
  { date: '2023-12-31', label: '2023', xirrValue: null },
  { date: '2024-12-31', label: '2024', xirrValue: -0.0567 },
];

/** 与组件内常量保持一致（PRD §9.5: 正红负绿） */
const POSITIVE_COLOR = 'hsl(0, 84%, 48%)';
const NEGATIVE_COLOR = 'hsl(142, 71%, 38%)';
const MUTED_COLOR = '#94a3b8';

describe('YearlyBarChart — 三态渲染冒烟（ECharts）', () => {
  afterEach(() => {
    cleanup();
    echartsSpy.options.length = 0;
  });

  it('态一 loading：渲染 Skeleton 占位，图表不在 DOM', () => {
    const { container } = render(<YearlyBarChart data={YEARLY_DATA} loading />);

    expectLoadingState(container);
    expect(echartsSpy.options).toHaveLength(0);
    expect(container.textContent).toContain('年度 XIRR 对比');
  });

  it('态二 空数据：data 为 [] 或 undefined 时渲染「暂无数据」，图表不在 DOM', () => {
    const emptyArray = render(<YearlyBarChart data={[]} />);
    expectEmptyState(emptyArray.container);
    cleanup();

    const undefinedData = render(
      <YearlyBarChart data={undefined as unknown as XirrSeriesPoint[]} />,
    );
    expectEmptyState(undefinedData.container);

    expect(echartsSpy.options).toHaveLength(0);
  });

  it('态三 正常数据（含 null 点）：渲染图表、标题正确、逐柱着色与 Tooltip 分支正确', () => {
    const { container } = render(<YearlyBarChart data={YEARLY_DATA} />);

    const chart = expectChartState(container);
    expect(chart.getAttribute('data-testid')).toBe(CHART_MOCK_TESTID);
    // 默认 title 契约与迁移前一致
    expect(container.textContent).toContain('年度 XIRR 对比');

    // ---- option 结构 ----
    const option = lastOption(echartsSpy);
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.boundaryGap).toBe(true); // 柱状图两端留白
    expect(option.xAxis.data).toEqual(['2022', '2023', '2024']);

    expect(option.series).toHaveLength(1);
    const [bar] = option.series;
    expect(bar?.type).toBe('bar');
    // null 点原样保留（ECharts 不绘制该柱），不得被 0 顶替造成「零收益」误读
    expect(bar?.data).toEqual([0.1234, null, -0.0567]);

    const serialized = parseChartOption(chart);
    expect(JSON.stringify(serialized)).toContain('null');

    // ---- 逐柱着色回调（等价迁移前的 <Cell fill={...} />）----
    const colorFn = bar?.itemStyle?.color;
    expect(typeof colorFn).toBe('function');
    if (typeof colorFn !== 'function') throw new Error('itemStyle.color 应为逐柱着色回调');

    expect(colorFn({ dataIndex: 0 })).toBe(POSITIVE_COLOR); // 正收益 → 红（PRD §9.5: 正红负绿）
    expect(colorFn({ dataIndex: 1 })).toBe(MUTED_COLOR); // null → 灰（不崩）
    expect(colorFn({ dataIndex: 2 })).toBe(NEGATIVE_COLOR); // 负收益 → 绿
    // 越界索引不应抛错（ECharts 内部可能在动画期传入过期 index）
    expect(() => colorFn({ dataIndex: 99 })).not.toThrow();

    // ---- Tooltip 分支：null → 「数据不足」；数值 → formatPercent(2 位) ----
    const nullTooltip = option.tooltip.formatter([
      { axisValueLabel: '2023', seriesName: 'XIRR', value: null, dataIndex: 1 },
    ]);
    expect(nullTooltip).toContain('数据不足');
    expect(nullTooltip).not.toContain('NaN');

    const positiveTooltip = option.tooltip.formatter([
      { axisValueLabel: '2022', seriesName: 'XIRR', value: 0.1234, dataIndex: 0 },
    ]);
    expect(positiveTooltip).toContain('12.34%');

    const negativeTooltip = option.tooltip.formatter([
      { axisValueLabel: '2024', seriesName: 'XIRR', value: -0.0567, dataIndex: 2 },
    ]);
    expect(negativeTooltip).toContain('-5.67%');
  });
});
