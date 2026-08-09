/**
 * chart-grid.test.ts — ECharts grid 统一口径回归（问题①：x 轴末位日期裁切）
 *
 * 覆盖：
 * 1. BASE_GRID 右侧留白 ≥ 日期标签半宽（防止有人把 right 调小导致问题①复发）
 * 2. containLabel 恒开启
 * 3. chartGrid() 浅合并语义：overrides 优先、未覆盖字段继承
 * 4. 各图实际 grid 的 right 均达标（守住 5 处调用点的一致性）
 */

import { describe, expect, it } from 'vitest';
import {
  AXIS_LABEL_HALF_WIDTH,
  BASE_GRID,
  chartGrid,
} from '@/components/charts/chart-grid';

/** `YYYY-MM-DD` 在 12px 字号下的半宽下限，低于此值末位标签必被裁切 */
const MIN_SAFE_RIGHT = 35;

describe('chart-grid — BASE_GRID 基础口径', () => {
  it('right 留白不小于日期标签半宽（问题① 根因防线）', () => {
    expect(AXIS_LABEL_HALF_WIDTH).toBeGreaterThanOrEqual(MIN_SAFE_RIGHT);
    expect(BASE_GRID.right).toBe(AXIS_LABEL_HALF_WIDTH);
  });

  it('containLabel 开启，保证轴标签整体不溢出容器', () => {
    expect(BASE_GRID.containLabel).toBe(true);
  });

  it('四向留白均为具体数值，无 undefined 造成 ECharts 回落默认值', () => {
    expect(typeof BASE_GRID.left).toBe('number');
    expect(typeof BASE_GRID.right).toBe('number');
    expect(typeof BASE_GRID.top).toBe('number');
    expect(typeof BASE_GRID.bottom).toBe('number');
  });
});

describe('chart-grid — chartGrid() 合并语义', () => {
  it('无参调用等价于 BASE_GRID', () => {
    expect(chartGrid()).toEqual(BASE_GRID);
  });

  it('返回新对象，不污染 BASE_GRID', () => {
    const g = chartGrid({ bottom: 5 });
    expect(g).not.toBe(BASE_GRID);
    expect(BASE_GRID.bottom).toBe(28);
  });

  it('overrides 覆盖指定字段，其余继承', () => {
    const g = chartGrid({ bottom: 5 });
    expect(g.bottom).toBe(5);
    expect(g.right).toBe(AXIS_LABEL_HALF_WIDTH);
    expect(g.left).toBe(BASE_GRID.left);
    expect(g.containLabel).toBe(true);
  });

  it('热力图式多字段覆盖仍保留 right 留白', () => {
    const g = chartGrid({ top: 30, bottom: 40, left: 60 });
    expect(g).toEqual({
      left: 60,
      right: AXIS_LABEL_HALF_WIDTH,
      top: 30,
      bottom: 40,
      containLabel: true,
    });
  });

  it('允许显式覆盖 right（逃生舱口，但仍需调用方自证安全）', () => {
    expect(chartGrid({ right: 80 }).right).toBe(80);
  });
});

describe('chart-grid — 各图调用点 right 达标', () => {
  // 与 nav-trend / xirr-trend / yearly-bar / monthly-heatmap / transactions
  // 五处调用点的 overrides 一一对应
  const callSites: Array<[string, ReturnType<typeof chartGrid>]> = [
    ['nav-trend-chart', chartGrid()],
    ['xirr-trend-chart', chartGrid({ bottom: 5 })],
    ['yearly-bar-chart', chartGrid({ bottom: 5 })],
    ['monthly-heatmap', chartGrid({ top: 30, bottom: 40, left: 60 })],
    ['transactions 出入金趋势', chartGrid()],
  ];

  it.each(callSites)('%s 的 right ≥ %i', (_name, grid) => {
    expect(grid.right as number).toBeGreaterThanOrEqual(MIN_SAFE_RIGHT);
  });
});
