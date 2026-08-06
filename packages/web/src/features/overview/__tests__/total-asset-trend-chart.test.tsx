/**
 * features/overview/total-asset-trend-chart.tsx — 走势图单测
 *
 * 覆盖（对应设计 §11.3 N-16 ~ N-21）：
 * 1. 纯函数：`buildTrendPoints`（null 点丢弃、totalAsset = nav × shares）、
 *    `collectManualDates`、`buildManualScatter`
 * 2. 三态渲染：loading → Skeleton；空 → 「当前范围暂无资产数据」；正常 → 图表
 * 3. 🔴 手工标记查询走服务端筛选：`source=MANUAL` + `pageSize=200`
 *    （旧实现 pageSize:60 + 前端过滤，在长区间会截断标记）
 * 4. 卡头两个 /snapshots 入口（`?manage=1` 深链是全站唯一入口，不可丢）
 * 5. 手工记录数超 200 → 灰字提示
 *
 * jsdom 无 Canvas，`echarts.init()` 会抛错 → 必须 mock `echarts-for-react`，
 * 只验证 DOM 三态与 option 结构（与 charts/__tests__ 既有做法一致）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NavSeriesPoint } from '@investment-tracker/shared';

// ---------------------------------------------------------------------------
// 替身（vi.hoisted 保证捕获槽先于 vi.mock 工厂初始化）
// ---------------------------------------------------------------------------
const echartsSpy = vi.hoisted(() => ({ options: [] as unknown[] }));

const snapshotSpy = vi.hoisted(() => ({
  /** 记录 useSnapshots 收到的 (portfolioId, query) */
  calls: [] as Array<{ portfolioId: unknown; query: Record<string, unknown> }>,
  /** 返回值槽 */
  result: { data: undefined as unknown, isLoading: false, isError: false },
}));

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

vi.mock('@/hooks/use-snapshots', () => ({
  useSnapshots: (portfolioId: unknown, query: Record<string, unknown>) => {
    snapshotSpy.calls.push({ portfolioId, query });
    return snapshotSpy.result;
  },
}));

// 必须在 vi.mock 之后导入被测模块
import {
  buildManualScatter,
  buildTrendPoints,
  collectManualDates,
  MANUAL_MARK_PAGE_SIZE,
  TotalAssetTrendChart,
} from '@/features/overview/total-asset-trend-chart';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const NAV_DATA: NavSeriesPoint[] = [
  {
    date: '2026-04-30',
    label: '2026-04',
    cumulativeNav: 1.2,
    yearNav: 1.02,
    shares: 100000,
  },
  {
    // null 点：必须被丢弃（无法计算总资产）
    date: '2026-05-31',
    label: '2026-05',
    cumulativeNav: null,
    yearNav: null,
    shares: null,
  },
  {
    date: '2026-06-30',
    label: '2026-06',
    cumulativeNav: 1.25,
    yearNav: 1.05,
    shares: 120000,
  },
];

function snapshotPage(
  items: Array<{ date: string; source: string }>,
  total = items.length,
) {
  return { items, total, page: 1, pageSize: MANUAL_MARK_PAGE_SIZE };
}

function renderChart(
  props: Partial<React.ComponentProps<typeof TotalAssetTrendChart>> = {},
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <TotalAssetTrendChart
        data={NAV_DATA}
        portfolioId="pf-1"
        startDate="2026-01-01"
        endDate="2026-06-30"
        {...props}
      />
    </MemoryRouter>,
  );
}

/** 取最近一次传入 ECharts 的 option（保留函数字段） */
function lastOption(): {
  xAxis: { data: string[] };
  series: Array<{ name: string; type: string; data: unknown[] }>;
} {
  const { options } = echartsSpy;
  expect(options.length).toBeGreaterThan(0);
  return options[options.length - 1] as {
    xAxis: { data: string[] };
    series: Array<{ name: string; type: string; data: unknown[] }>;
  };
}

beforeEach(() => {
  echartsSpy.options = [];
  snapshotSpy.calls = [];
  snapshotSpy.result = { data: undefined, isLoading: false, isError: false };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
describe('buildTrendPoints — 总资产 = 累计净值 × 份额', () => {
  it('丢弃 cumulativeNav / shares 任一为 null 的点', () => {
    const points = buildTrendPoints(NAV_DATA);

    expect(points).toHaveLength(2);
    expect(points.map((p) => p.date)).toEqual(['2026-04-30', '2026-06-30']);
  });

  it('totalAsset 为两者乘积，label / date 原样透传', () => {
    const points = buildTrendPoints(NAV_DATA);

    expect(points[0]).toEqual({
      date: '2026-04-30',
      label: '2026-04',
      totalAsset: 1.2 * 100000,
    });
    expect(points[1].totalAsset).toBeCloseTo(1.25 * 120000, 6);
  });

  it('空 / null / undefined 入参 → 空数组，不抛错', () => {
    expect(buildTrendPoints([])).toEqual([]);
    expect(buildTrendPoints(null)).toEqual([]);
    expect(buildTrendPoints(undefined)).toEqual([]);
  });

  it('总资产为 0（份额为 0）属合法点，不得被丢弃', () => {
    const points = buildTrendPoints([
      { date: '2026-06-30', label: '2026-06', cumulativeNav: 1.1, yearNav: 1, shares: 0 },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].totalAsset).toBe(0);
  });
});

describe('collectManualDates / buildManualScatter', () => {
  it('只收集 source=MANUAL 的日期（纵深防御：后端未筛选时前端兜底）', () => {
    const set = collectManualDates([
      { date: '2026-04-30', source: 'MANUAL' },
      { date: '2026-05-31', source: 'DERIVED' },
    ]);

    expect(set.has('2026-04-30')).toBe(true);
    expect(set.has('2026-05-31')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('空入参 → 空集合', () => {
    expect(collectManualDates(undefined).size).toBe(0);
    expect(collectManualDates(null).size).toBe(0);
    expect(collectManualDates([]).size).toBe(0);
  });

  it('散点为 [走势点下标, 总资产]，只标记落在走势点上的手工日期', () => {
    const points = buildTrendPoints(NAV_DATA);
    const scatter = buildManualScatter(
      points,
      new Set(['2026-06-30', '2026-05-31']), // 后者是被丢弃的 null 点，不应出现
    );

    expect(scatter).toHaveLength(1);
    expect(scatter[0][0]).toBe(1); // 走势点下标（null 点已被剔除，索引重排）
    expect(scatter[0][1]).toBeCloseTo(1.25 * 120000, 6);
  });
});

// ---------------------------------------------------------------------------
// 渲染三态
// ---------------------------------------------------------------------------
describe('TotalAssetTrendChart — 三态渲染', () => {
  it('loading → Skeleton（h-[260px]），图表不在 DOM', () => {
    const { container } = renderChart({ loading: true });

    const skeleton = container.querySelector<HTMLElement>('.animate-pulse');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.classList.contains('h-[260px]')).toBe(true);
    expect(screen.queryByTestId('echarts-mock')).toBeNull();
  });

  it('无可绘制点 → 「当前范围暂无资产数据」，且不发手工标记请求', () => {
    renderChart({ data: [] });

    expect(screen.getByText('当前范围暂无资产数据')).toBeDefined();
    expect(screen.queryByTestId('echarts-mock')).toBeNull();
    // 无点时关闭快照查询（portfolioId 传 null → useSnapshots 内部 disabled）
    expect(snapshotSpy.calls[snapshotSpy.calls.length - 1].portfolioId).toBeNull();
  });

  it('正常数据 → 渲染图表，x 轴为过滤后的 label，折线为总资产', () => {
    renderChart();

    expect(screen.getByTestId('echarts-mock')).toBeDefined();
    const option = lastOption();
    expect(option.xAxis.data).toEqual(['2026-04', '2026-06']);

    const line = option.series.find((s) => s.name === '总资产');
    expect(line?.type).toBe('line');
    expect(line?.data).toEqual([120000, 150000]);
  });
});

// ---------------------------------------------------------------------------
// 手工记录标记
// ---------------------------------------------------------------------------
describe('TotalAssetTrendChart — 手工记录标记', () => {
  it('🔴 走服务端筛选：source=MANUAL + pageSize=200 + 当前区间（N-17 回归）', () => {
    renderChart();

    const call = snapshotSpy.calls[snapshotSpy.calls.length - 1];
    expect(call.portfolioId).toBe('pf-1');
    expect(call.query.source).toBe('MANUAL');
    expect(call.query.pageSize).toBe(200);
    expect(call.query.startDate).toBe('2026-01-01');
    expect(call.query.endDate).toBe('2026-06-30');
  });

  it('区间变化 → 以新区间重新查询快照', () => {
    const { rerender } = renderChart();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <TotalAssetTrendChart
          data={NAV_DATA}
          portfolioId="pf-1"
          startDate="2024-01-01"
          endDate="2026-06-30"
        />
      </MemoryRouter>,
    );

    const call = snapshotSpy.calls[snapshotSpy.calls.length - 1];
    expect(call.query.startDate).toBe('2024-01-01');
  });

  it('手工快照落在走势点上 → 生成散点系列', () => {
    snapshotSpy.result = {
      data: snapshotPage([{ date: '2026-06-30', source: 'MANUAL' }]),
      isLoading: false,
      isError: false,
    };

    renderChart();

    const scatter = lastOption().series.find((s) => s.name === '手工记录');
    expect(scatter?.type).toBe('scatter');
    expect(scatter?.data).toHaveLength(1);
    expect(scatter?.data[0]).toEqual([1, 150000]);
  });

  it('无手工快照 → 散点系列仍注册但数据为空（图例稳定）', () => {
    renderChart();

    const scatter = lastOption().series.find((s) => s.name === '手工记录');
    expect(scatter).toBeDefined();
    expect(scatter?.data).toHaveLength(0);
  });

  it('总数超过 200 → 渲染截断灰字提示', () => {
    snapshotSpy.result = {
      data: snapshotPage([{ date: '2026-06-30', source: 'MANUAL' }], 321),
      isLoading: false,
      isError: false,
    };

    renderChart();

    expect(screen.getByText(/仅显示前 200 个手工记录标记/)).toBeDefined();
  });

  it('总数未超过 200 → 无截断提示', () => {
    snapshotSpy.result = {
      data: snapshotPage([{ date: '2026-06-30', source: 'MANUAL' }], 7),
      isLoading: false,
      isError: false,
    };

    renderChart();

    expect(screen.queryByText(/仅显示前 200 个手工记录标记/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 卡头入口（从出入金页迁移，manage=1 深链保活）
// ---------------------------------------------------------------------------
describe('TotalAssetTrendChart — 卡头 /snapshots 入口（N-21）', () => {
  it('「查看全部历史」→ /snapshots', () => {
    renderChart();

    const link = screen.getByRole('link', { name: /查看全部历史/ });
    expect(link.getAttribute('href')).toBe('/snapshots');
  });

  it('🔴「管理历史记录」→ /snapshots?manage=1（全站唯一深链入口）', () => {
    renderChart();

    const link = screen.getByRole('link', { name: /管理历史记录/ });
    expect(link.getAttribute('href')).toBe('/snapshots?manage=1');
  });

  it('入口在空态下同样可达（删除出入金页入口后不得失联）', () => {
    renderChart({ data: [] });

    expect(
      screen.getByRole('link', { name: /管理历史记录/ }).getAttribute('href'),
    ).toBe('/snapshots?manage=1');
  });

  it('链接文案不与概览页「查看全部」（近期出入金卡）冲突', () => {
    renderChart();

    // 精确匹配「查看全部」不应命中「查看全部历史」，否则会打破 A6 的单数断言
    expect(screen.queryByText('查看全部')).toBeNull();
  });
});
