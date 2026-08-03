/**
 * components/charts/__tests__/chart-test-utils.ts — 图表组件三态渲染测试公共断言工具
 *
 * 背景：3 个图表组件（nav-trend-chart / xirr-trend-chart / yearly-bar-chart）
 * 由 recharts 迁移至 ECharts，三者共享同一套「loading / 空态 / 正常」渲染骨架，
 * 故把三态断言与 option 类型抽到此处，避免三份测试文件三倍复制。
 *
 * 注意：
 * 1. 本文件**不是**测试文件（不匹配 vitest 的 `*.test.*` 收集模式），仅作工具模块。
 * 2. 本文件**不做** `vi.mock`。`vi.mock('echarts-for-react')` 必须写在各测试文件内
 *    （模块注册表按测试文件隔离），避免跨文件共享 mock 实例带来的不确定性。
 */

import { expect } from 'vitest';

// ---------------------------------------------------------------------------
// ECharts option 结构类型（仅声明被测组件实际产出、且测试会断言的字段）
// ---------------------------------------------------------------------------

/** ECharts `trigger: 'axis'` tooltip 回调入参（构造测试入参用） */
export interface AxisTooltipParamLike {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | string | null;
  dataIndex: number;
}

export interface CapturedSeries {
  name?: string;
  type: string;
  connectNulls?: boolean;
  showSymbol?: boolean;
  smooth?: boolean;
  data: (number | null)[];
  itemStyle?: {
    color?: string | ((params: { dataIndex: number }) => string);
    borderRadius?: number[];
  };
}

export interface CapturedOption {
  tooltip: {
    trigger: string;
    formatter: (params: AxisTooltipParamLike | AxisTooltipParamLike[]) => string;
  };
  xAxis: { type: string; boundaryGap: boolean; data: string[] };
  yAxis: { type: string };
  series: CapturedSeries[];
}

// ---------------------------------------------------------------------------
// DOM 断言锚点
// ---------------------------------------------------------------------------

/** 图表 mock 的 testid（各测试文件的 vi.mock 工厂需产出同名节点） */
export const CHART_MOCK_TESTID = 'echarts-mock';

const CHART_MOCK_SELECTOR = `[data-testid="${CHART_MOCK_TESTID}"]`;
/** shadcn Skeleton 的基类锚点；尺寸类 `h-[260px] w-full` 另行用 classList 判定 */
const SKELETON_SELECTOR = '.animate-pulse';

/** 取 Skeleton 节点（不存在返回 null） */
export function querySkeleton(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(SKELETON_SELECTOR);
}

/** 取图表 mock 节点（不存在返回 null） */
export function queryChartMock(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(CHART_MOCK_SELECTOR);
}

/** 取图表 mock 节点（不存在直接抛错，便于定位失败） */
export function getChartMock(container: HTMLElement): HTMLElement {
  const el = queryChartMock(container);
  if (!el) throw new Error(`未找到图表渲染容器 ${CHART_MOCK_SELECTOR}`);
  return el;
}

/**
 * 态一：loading。
 * 断言渲染 Skeleton（`h-[260px] w-full`），且图表与空态均不在 DOM。
 */
export function expectLoadingState(container: HTMLElement): void {
  const skeleton = querySkeleton(container);
  expect(skeleton).not.toBeNull();
  // 尺寸类是设计文档 §10 视觉等价清单锚点，必须逐个校验（含方括号任意值类）
  expect(skeleton?.classList.contains('h-[260px]')).toBe(true);
  expect(skeleton?.classList.contains('w-full')).toBe(true);

  expect(queryChartMock(container)).toBeNull();
  expect(container.textContent).not.toContain('暂无数据');
}

/**
 * 态二：空数据。
 * 断言渲染「暂无数据」文案，且图表与 Skeleton 均不在 DOM。
 */
export function expectEmptyState(container: HTMLElement): void {
  expect(container.textContent).toContain('暂无数据');
  expect(queryChartMock(container)).toBeNull();
  expect(querySkeleton(container)).toBeNull();
}

/**
 * 态三：正常数据。
 * 断言图表 mock 在 DOM、option 已透传（data-option 可解析），且无 loading/空态残留。
 */
export function expectChartState(container: HTMLElement): HTMLElement {
  const chart = getChartMock(container);
  expect(querySkeleton(container)).toBeNull();
  expect(container.textContent).not.toContain('暂无数据');

  const raw = chart.getAttribute('data-option');
  expect(raw).toBeTruthy();
  // 能被 JSON.parse 说明 option 是可序列化的普通对象（函数字段会被丢弃，属预期）
  expect(() => JSON.parse(raw ?? '')).not.toThrow();

  return chart;
}

/** 从 mock 节点的 data-option 上解析出可序列化部分（函数字段已被丢弃） */
export function parseChartOption(chart: HTMLElement): Record<string, unknown> {
  return JSON.parse(chart.getAttribute('data-option') ?? '{}') as Record<
    string,
    unknown
  >;
}

/**
 * 取最近一次传入 ECharts 的 option（保留函数字段，可直接调用 formatter）。
 * 传入各测试文件用 `vi.hoisted` 建立的捕获槽。
 */
export function lastOption(spy: { options: unknown[] }): CapturedOption {
  const { options } = spy;
  expect(options.length).toBeGreaterThan(0);
  // 不用 Array.prototype.at：tsconfig lib 为 ES2020，at 属 ES2022
  return options[options.length - 1] as CapturedOption;
}
