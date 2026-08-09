/**
 * components/charts/xirr-trend-chart.tsx — 三态渲染冒烟测试（ECharts 迁移回归）
 *
 * 覆盖三态：
 * 1. loading=true       → Skeleton（h-[260px] w-full），图表不在 DOM
 * 2. data 空（[] / undefined） → 「暂无数据」，图表不在 DOM
 * 3. 正常数据（含 null 点） → 图表在 DOM、标题「XIRR 趋势」、option 结构正确、不抛错
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
// echarts-for-react 替身（同 nav-trend-chart.test.tsx，mock 必须按测试文件隔离）
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
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';

// ---------------------------------------------------------------------------
// 夹具：严格遵循 shared 的 XirrSeriesPoint 契约（date 为必填）
// 第 2 个点 xirrValue = null，用于校验 connectNulls 与 Tooltip「数据不足」分支
// ---------------------------------------------------------------------------
const XIRR_DATA: XirrSeriesPoint[] = [
  { date: '2024-01-31', label: '2024-01', xirrValue: 0.0821 },
  { date: '2024-02-29', label: '2024-02', xirrValue: null },
  { date: '2024-03-31', label: '2024-03', xirrValue: -0.0345 },
];

describe('XirrTrendChart — 三态渲染冒烟（ECharts）', () => {
  afterEach(() => {
    cleanup();
    echartsSpy.options.length = 0;
  });

  it('态一 loading：渲染 Skeleton 占位，图表不在 DOM', () => {
    const { container } = render(<XirrTrendChart data={XIRR_DATA} loading />);

    expectLoadingState(container);
    expect(echartsSpy.options).toHaveLength(0);
    expect(container.textContent).toContain('XIRR 趋势');
  });

  it('态二 空数据：data 为 [] 或 undefined 时渲染「暂无数据」，图表不在 DOM', () => {
    const emptyArray = render(<XirrTrendChart data={[]} />);
    expectEmptyState(emptyArray.container);
    cleanup();

    const undefinedData = render(
      <XirrTrendChart data={undefined as unknown as XirrSeriesPoint[]} />,
    );
    expectEmptyState(undefinedData.container);

    expect(echartsSpy.options).toHaveLength(0);
  });

  it('态三 正常数据（含 null 点）：渲染图表、标题正确、option 结构正确且不抛错', () => {
    const { container } = render(<XirrTrendChart data={XIRR_DATA} />);

    const chart = expectChartState(container);
    expect(chart.getAttribute('data-testid')).toBe(CHART_MOCK_TESTID);
    // 默认 title 契约与迁移前一致
    expect(container.textContent).toContain('XIRR 趋势');

    // ---- option 结构 ----
    const option = lastOption(echartsSpy);
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.boundaryGap).toBe(false); // 折线图贴边
    expect(option.xAxis.data).toEqual(['2024-01', '2024-02', '2024-03']);

    expect(option.series).toHaveLength(1);
    const [line] = option.series;
    expect(line?.type).toBe('line');
    expect(line?.name).toBe('XIRR');
    // null 点原样保留，负值不被丢弃
    expect(line?.data).toEqual([0.0821, null, -0.0345]);
    expect(line?.connectNulls).toBe(true);

    const serialized = parseChartOption(chart);
    expect(JSON.stringify(serialized)).toContain('null');

    // ---- Tooltip 分支：null → 「数据不足」；数值 → formatPercent(2 位) ----
    const nullTooltip = option.tooltip.formatter([
      { axisValueLabel: '2024-02', seriesName: 'XIRR', value: null, dataIndex: 1 },
    ]);
    expect(nullTooltip).toContain('数据不足');
    expect(nullTooltip).not.toContain('NaN');

    const positiveTooltip = option.tooltip.formatter([
      { axisValueLabel: '2024-01', seriesName: 'XIRR', value: 0.0821, dataIndex: 0 },
    ]);
    expect(positiveTooltip).toContain('8.21%');

    const negativeTooltip = option.tooltip.formatter([
      { axisValueLabel: '2024-03', seriesName: 'XIRR', value: -0.0345, dataIndex: 2 },
    ]);
    expect(negativeTooltip).toContain('-3.45%');
  });
});
