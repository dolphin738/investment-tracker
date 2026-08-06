/**
 * features/overview/total-asset-trend-chart.tsx — 走势图单测
 *
 * 覆盖（对应设计 §11.3 N-16 ~ N-21）：
 * 1. 纯函数：`buildTrendPoints`（null 点丢弃、totalAsset = nav × shares）、
 *    `collectManualDates`、`buildManualScatter`
 * 2. 三态渲染：loading → Skeleton；空 → 「当前范围暂无资产数据」；正常 → 图表
 * 3. 🔴 手工标记查询走服务端筛选：`source=MANUAL` + `pageSize=200`
 *    （旧实现 pageSize:60 + 前端过滤，在长区间会截断标记）
 * 4. 卡头单一 /snapshots 入口（「查看全部历史」，无 ?manage=1 深链）
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
const echartsSpy = vi.hoisted(() => ({
  options: [] as unknown[],
  /** 记录传给图表的 style（hero 高度断言的观测点） */
  styles: [] as Array<Record<string, unknown> | undefined>,
}));

const snapshotSpy = vi.hoisted(() => ({
  /** 记录 useSnapshots 收到的 (portfolioId, query) */
  calls: [] as Array<{ portfolioId: unknown; query: Record<string, unknown> }>,
  /** 返回值槽 */
  result: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock('echarts-for-react', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: {
      option: unknown;
      style?: Record<string, unknown>;
    }) => {
      echartsSpy.options.push(props.option);
      echartsSpy.styles.push(props.style);
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
  formatAxisTooltip,
  formatAxisTooltipLine,
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
  echartsSpy.styles = [];
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
// axis tooltip formatter（Bug：手工记录散点数组值显示为 -）
// ---------------------------------------------------------------------------
describe('formatAxisTooltip — 兼容散点数组值（Bug 修复回归）', () => {
  const money = (v: number): string => `¥${v.toFixed(2)}`;

  it('折线 series 数值为 number → 直接格式化金额', () => {
    const line = formatAxisTooltipLine(
      { marker: '■', seriesName: '总资产', value: 150000, dataIndex: 0 },
      money,
    );
    expect(line).toBe('■总资产: ¥150000.00');
  });

  it('🔴 散点 series 数值为 [idx, totalAsset] 数组 → 取 [1] 格式化（不再显示 -）', () => {
    const line = formatAxisTooltipLine(
      { marker: '●', seriesName: '手工记录', value: [1, 150000], dataIndex: 1 },
      money,
    );
    expect(line).toBe('●手工记录: ¥150000.00');
  });

  it('null / undefined → 保持「数据不足」分支', () => {
    expect(
      formatAxisTooltipLine(
        { marker: '■', seriesName: '总资产', value: null, dataIndex: 0 },
        money,
      ),
    ).toBe('■总资产: 数据不足');
    expect(
      formatAxisTooltipLine(
        { marker: '■', seriesName: '总资产', value: undefined, dataIndex: 0 },
        money,
      ),
    ).toBe('■总资产: 数据不足');
  });

  it('整体 formatter：头部日期 + 每系列一行，<br/> 分隔（格式不变）', () => {
    const html = formatAxisTooltip(
      [
        {
          axisValueLabel: '2026-06',
          marker: '■',
          seriesName: '总资产',
          value: 150000,
          dataIndex: 0,
        },
        {
          axisValueLabel: '2026-06',
          marker: '●',
          seriesName: '手工记录',
          value: [1, 150000],
          dataIndex: 1,
        },
      ],
      money,
    );
    expect(html).toBe('2026-06<br/>■总资产: ¥150000.00<br/>●手工记录: ¥150000.00');
  });

  it('🔴 渲染产物回归：axis tooltip formatter 对散点数组值输出金额而非 -', () => {
    snapshotSpy.result = {
      data: snapshotPage([{ date: '2026-06-30', source: 'MANUAL' }]),
      isLoading: false,
      isError: false,
    };

    renderChart();

    const option = lastOption() as unknown as {
      tooltip: { formatter: (params: unknown) => string };
    };
    const html = option.tooltip.formatter([
      {
        axisValueLabel: '2026-06',
        marker: '■',
        seriesName: '总资产',
        value: 150000,
        dataIndex: 0,
      },
      {
        axisValueLabel: '2026-06',
        marker: '●',
        seriesName: '手工记录',
        value: [1, 150000],
        dataIndex: 1,
      },
    ]);

    // formatCurrency 默认千分位
    expect(html).toContain('手工记录: ¥150,000.00');
    expect(html).not.toContain('手工记录: -');
  });
});

// ---------------------------------------------------------------------------
// 渲染三态
// ---------------------------------------------------------------------------
describe('TotalAssetTrendChart — 三态渲染', () => {
  // 高度 260→300：概览页布局打磨后本图升为「趋势分析」区的 hero 图，
  // 比四宫格里的辅图（仍 260px）更高，骨架屏须与 CHART_HEIGHT 保持一致。
  it('loading → Skeleton（h-[300px]），图表不在 DOM', () => {
    const { container } = renderChart({ loading: true });

    const skeleton = container.querySelector<HTMLElement>('.animate-pulse');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.classList.contains('h-[300px]')).toBe(true);
    expect(skeleton?.classList.contains('h-[260px]')).toBe(false);
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
// hero 高度（布局打磨 f1013f3：260 → 300）
// ---------------------------------------------------------------------------
/**
 * 【为什么值得单独一组】高度写在三处：`CHART_HEIGHT` 常量、骨架屏 `h-[300px]`、
 * 空态 `h-[300px]`。Tailwind 不认模板串拼接的任意值类，所以后两处只能是字面量，
 * 天然存在「改常量忘改字面量」的漂移风险 —— 表现为加载中/空态与出图后高度突变
 * （页面跳动）。这里把三处钉在一起，任一处回退到 260 都会红。
 */
describe('TotalAssetTrendChart — hero 高度三处一致（300px）', () => {
  it('出图后 ECharts 容器高度为 300', () => {
    renderChart();

    const style = echartsSpy.styles[echartsSpy.styles.length - 1];
    expect(style?.height).toBe(300);
    expect(style?.width).toBe('100%');
  });

  it('空态占位高度同为 h-[300px]（与出图后不跳动）', () => {
    renderChart({ data: [] });

    const empty = screen.getByText('当前范围暂无资产数据');
    expect(empty.classList.contains('h-[300px]')).toBe(true);
    expect(empty.classList.contains('h-[260px]')).toBe(false);
  });

  it('🔴 骨架屏 / 空态 / 出图三态高度完全一致', () => {
    const { container: loadingBox } = renderChart({ loading: true });
    const skeletonH = loadingBox
      .querySelector<HTMLElement>('.animate-pulse')
      ?.className.match(/h-\[(\d+)px\]/)?.[1];
    cleanup();

    renderChart({ data: [] });
    const emptyH = screen
      .getByText('当前范围暂无资产数据')
      .className.match(/h-\[(\d+)px\]/)?.[1];
    cleanup();

    renderChart();
    const chartH = echartsSpy.styles[echartsSpy.styles.length - 1]?.height;

    expect(skeletonH).toBe('300');
    expect(emptyH).toBe('300');
    expect(chartH).toBe(300);
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
// 卡头入口（单一 /snapshots 入口，无 manage=1 深链）
// ---------------------------------------------------------------------------
describe('TotalAssetTrendChart — 卡头 /snapshots 入口（N-21）', () => {
  it('「查看全部历史」→ /snapshots（单一入口，无 ?manage=1 变体）', () => {
    renderChart();

    const link = screen.getByRole('link', { name: /查看全部历史/ });
    expect(link.getAttribute('href')).toBe('/snapshots');

    // 全页指向 /snapshots 的链接仅此一个（不存在 ?manage=1 深链变体）
    const snapshotLinks = screen
      .getAllByRole('link')
      .filter((el) => (el.getAttribute('href') ?? '').startsWith('/snapshots'));
    expect(snapshotLinks).toHaveLength(1);
  });

  it('链接文案不与概览页「查看全部」（近期出入金卡）冲突', () => {
    renderChart();

    // 精确匹配「查看全部」不应命中「查看全部历史」，否则会打破 A6 的单数断言
    expect(screen.queryByText('查看全部')).toBeNull();
  });
});
