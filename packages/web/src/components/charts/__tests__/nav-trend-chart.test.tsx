/**
 * components/charts/nav-trend-chart.tsx — 三态渲染冒烟测试（ECharts 迁移回归）
 *
 * 覆盖三态：
 * 1. loading=true       → Skeleton（h-[260px] w-full），图表不在 DOM
 * 2. data 空（[] / undefined） → 「暂无数据」，图表不在 DOM
 * 3. 正常数据（含 null 点） → 图表在 DOM、标题「净值趋势」、option 结构正确、不抛错
 *
 * 关键约束（架构增量设计 §7.6）：
 * jsdom 无 Canvas，`echarts.init()` 会抛错，因此必须 mock `echarts-for-react`，
 * 只验证三态 DOM 与 option 结构，不真渲染 canvas。禁止为此引入
 * `canvas` / `jest-canvas-mock` 等新依赖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { NavSeriesPoint } from '@investment-tracker/shared';
import {
  CHART_MOCK_TESTID,
  expectChartState,
  expectEmptyState,
  expectLoadingState,
  lastOption,
  parseChartOption,
} from './chart-test-utils';

// ---------------------------------------------------------------------------
// echarts-for-react 替身（vi.hoisted 保证捕获槽在 vi.mock 工厂执行前已初始化）
// 工厂内用 createElement 而非 JSX：vi.mock 工厂会被提升到 import 之前，
// 直接写 JSX 会引用尚未初始化的 jsx-runtime 绑定。
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
import { NavTrendChart } from '@/components/charts/nav-trend-chart';

// ---------------------------------------------------------------------------
// 夹具：严格遵循 shared 的 NavSeriesPoint 契约（date / shares 均为必填）
// 第 2 个点为 null 点，用于校验 connectNulls 与 Tooltip「数据不足」分支
// ---------------------------------------------------------------------------
const NAV_DATA: NavSeriesPoint[] = [
  {
    date: '2024-01-31',
    label: '2024-01',
    cumulativeNav: 1.0,
    yearNav: 1.0,
    shares: 1000,
  },
  {
    date: '2024-02-29',
    label: '2024-02',
    cumulativeNav: null,
    yearNav: null,
    shares: null,
  },
  {
    date: '2024-03-31',
    label: '2024-03',
    cumulativeNav: 1.0512,
    yearNav: 1.0512,
    shares: 1200,
  },
];

describe('NavTrendChart — 三态渲染冒烟（ECharts）', () => {
  afterEach(() => {
    cleanup();
    echartsSpy.options.length = 0;
  });

  it('态一 loading：渲染 Skeleton 占位，图表不在 DOM', () => {
    const { container } = render(<NavTrendChart data={NAV_DATA} loading />);

    expectLoadingState(container);
    // loading 期间不应触发 ECharts 渲染
    expect(echartsSpy.options).toHaveLength(0);
    // 标题在三态下均应保留
    expect(container.textContent).toContain('净值趋势');
  });

  it('态二 空数据：data 为 [] 或 undefined 时渲染「暂无数据」，图表不在 DOM', () => {
    const emptyArray = render(<NavTrendChart data={[]} />);
    expectEmptyState(emptyArray.container);
    cleanup();

    // 防御性分支：调用方可能在数据未就绪时传入 undefined（组件内有 !data 兜底）
    const undefinedData = render(
      <NavTrendChart data={undefined as unknown as NavSeriesPoint[]} />,
    );
    expectEmptyState(undefinedData.container);

    expect(echartsSpy.options).toHaveLength(0);
  });

  it('态三 正常数据（含 null 点）：渲染图表、标题正确、option 结构正确且不抛错', () => {
    const { container } = render(<NavTrendChart data={NAV_DATA} />);

    // 图表在 DOM，且无 loading / 空态残留
    const chart = expectChartState(container);
    expect(chart.getAttribute('data-testid')).toBe(CHART_MOCK_TESTID);
    // 默认 title 契约与迁移前一致
    expect(container.textContent).toContain('净值趋势');

    // ---- option 结构 ----
    const option = lastOption(echartsSpy);
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.data).toEqual(['2024-01', '2024-02', '2024-03']);

    expect(option.series).toHaveLength(2);
    const [cumulative, year] = option.series;
    expect(cumulative?.name).toBe('累计净值');
    expect(year?.name).toBe('当年净值');

    // null 点必须原样保留（由 connectNulls 负责跨断点连线），不得被 0 / undefined 顶替
    expect(cumulative?.data).toEqual([1.0, null, 1.0512]);
    expect(year?.data).toEqual([1.0, null, 1.0512]);
    expect(cumulative?.connectNulls).toBe(true);
    expect(year?.connectNulls).toBe(true);

    // 序列化后 null 点仍在（确认透传到 ReactECharts 的 option 可安全序列化）
    const serialized = parseChartOption(chart);
    expect(JSON.stringify(serialized)).toContain('null');

    // ---- Tooltip 分支：null 点走「数据不足」，非空点走 formatDecimal(4 位) ----
    const nullTooltip = option.tooltip.formatter([
      { axisValueLabel: '2024-02', seriesName: '累计净值', value: null, dataIndex: 1 },
      { axisValueLabel: '2024-02', seriesName: '当年净值', value: null, dataIndex: 1 },
    ]);
    expect(nullTooltip).toContain('数据不足');
    expect(nullTooltip).not.toContain('NaN');

    const valueTooltip = option.tooltip.formatter([
      { axisValueLabel: '2024-03', seriesName: '累计净值', value: 1.0512, dataIndex: 2 },
    ]);
    expect(valueTooltip).toContain('1.0512');
    expect(valueTooltip).not.toContain('数据不足');
  });
});
