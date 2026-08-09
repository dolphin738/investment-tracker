/**
 * pages/dashboard.tsx — 概览页布局打磨验收（f1013f3 · QA 独立复验）
 *
 * 既有用例（alignment / fusion / hooks-order）验的是**数据链路与装配**：
 * 8 卡的值从哪来、走势图区间跟不跟手、combobox 是否唯一。本文件补的是
 * 这次纯展示层重构真正改动的那一层 —— **版面结构本身**，它此前没有任何断言：
 *
 * - L-01 页面分两个 Section：「关键指标」「趋势分析」，外层 `space-y-8`
 * - L-02 8 卡按 group 拆成「资产构成」4 +「收益表现」4，两组拼起来恰是
 *        buildOverviewMetrics 的原始顺序（分组只是 filter，不得增删改序）
 * - L-03 首张「当前总资产」带 `border-primary/30` 轻描边，其余 7 张不带
 * - L-04 两组共用同一套网格断点 `grid-cols-1 sm:grid-cols-2 md:grid-cols-4`
 *        （共用是「两行卡片列宽严格对齐」的前提，必须逐字相同）
 * - L-05 筛选栏 `flex-col sm:flex-row`：移动端堆叠、≥sm 一行
 * - L-06 趋势区内顺序严格为 筛选栏 → hero 走势图 → 四宫格
 * - L-07 Section / SectionTitle 未引入任何新 combobox（A8 单数断言的护栏）
 *
 * 【为什么断言 className】布局打磨的交付物就是这些类名，jsdom 不跑 CSS，
 * 断言类名是唯一能自动化守住「移动端不塌成两列挤压」的手段。类名是本次
 * 提交的**契约**（见 dashboard.tsx METRIC_GRID_CLASS 注释），不是实现细节。
 *
 * 策略：与 dashboard-fusion.test.tsx 一致 —— stub 重型图表，保留真实
 * QueryClient 与真实 DateRangeQuickPicker（combobox 唯一性必须在真组件上验）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@/lib/types';
import type { OverviewResponse, UserPreference } from '@/api/types';

// ---------------------------------------------------------------------------
// 夹具槽
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  portfolios: [] as unknown[],
  cashBalance: null as unknown,
}));

const apiMocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getPortfoliosSummary: vi.fn(),
  listTransactions: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({ data: state.portfolios, isLoading: false }),
}));

vi.mock('@/api/overview.api', () => ({
  getOverview: apiMocks.getOverview,
  getPortfoliosSummary: apiMocks.getPortfoliosSummary,
}));

vi.mock('@/api/transaction.api', () => ({
  listTransactions: apiMocks.listTransactions,
}));

vi.mock('@/hooks/use-cash-balances', () => ({
  useLatestCashBalance: () => ({
    data: state.cashBalance,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/hooks/use-query-data', () => {
  const idle = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  return {
    useXirrSeries: () => idle,
    useNavSeries: () => idle,
    useLatestXirr: () => ({
      data: null,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useLatestNav: () => ({
      data: null,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});

// hero 走势图替身：只保留一个可定位的占位节点（顺序断言的锚点）
vi.mock('@/features/overview/total-asset-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    TotalAssetTrendChart: () =>
      createElement(
        'div',
        { 'data-testid': 'total-asset-trend-chart' },
        '总资产走势',
      ),
  };
});

vi.mock('@/components/charts/nav-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    NavTrendChart: () =>
      createElement('div', { 'data-testid': 'nav-chart' }, '净值趋势图'),
  };
});
vi.mock('@/components/charts/xirr-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    XirrTrendChart: () =>
      createElement('div', { 'data-testid': 'xirr-chart' }, 'XIRR 趋势图'),
  };
});
vi.mock('@/features/cashflow/cashflow-form', async () => {
  const { createElement } = await import('react');
  return {
    CashflowForm: () => createElement('div', { 'data-testid': 'cashflow-form' }),
  };
});
vi.mock('@/features/security-trade/security-trade-form', async () => {
  const { createElement } = await import('react');
  return {
    SecurityTradeForm: () =>
      createElement('div', { 'data-testid': 'trade-form' }),
  };
});

// 必须在 vi.mock 之后导入
import DashboardPage from '@/pages/dashboard';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { buildOverviewMetrics } from '@/features/overview/asset-metrics';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const PORTFOLIO = {
  id: 'pf-1',
  userId: 'user-1',
  name: '测试组合',
  description: null,
  baseDate: '2024-01-01',
  currency: 'CNY',
  archivedAt: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as Portfolio;

const OVERVIEW: OverviewResponse = {
  totalAsset: '123456.78',
  cumulativeNav: '1.234500',
  yearNav: '0.950000',
  xirr: '0.0821',
  netInvested: '100000.00',
  totalReturnRate: '0.23450000',
  // 刻意设成负值：用于验证「收益表现」组的跌方向仍由 buildOverviewMetrics 决定
  yearReturnRate: '-0.05000000',
  latestDate: '2026-06-15',
  freshness: {
    staleDays: 3,
    isStale: false,
    latestPriceAsOf: '2026-06-15',
    latestPriceLagDays: 0,
    latestCashAsOf: '2026-06-15',
    latestCashLagDays: 0,
    reasons: [],
  },
  holdingsSummary: {
    totalMarketValue: '98000.00',
    totalCost: '80000.00',
    totalProfit: '18000.00',
    securityCount: 3,
  },
  recentTransactions: [],
};

const BASE_PREF: UserPreference = {
  id: 'pref-1',
  userId: 'user-1',
  defaultPortfolioId: 'pf-1',
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as UserPreference;

/** 页面喂给 buildOverviewMetrics 的等价入参 —— 期望值由口径函数产出，不在用例里硬抄 */
const EXPECTED_METRICS = buildOverviewMetrics({
  totalAsset: OVERVIEW.totalAsset,
  latestDate: OVERVIEW.latestDate,
  latestSource: null,
  marketValue: OVERVIEW.holdingsSummary?.totalMarketValue,
  cashBalance: '5000.00',
  cashAsOf: '2026-06-15',
  netInvested: OVERVIEW.netInvested,
  totalReturnRate: OVERVIEW.totalReturnRate,
  yearReturnRate: OVERVIEW.yearReturnRate,
  xirr: OVERVIEW.xirr,
  cumulativeNav: OVERVIEW.cumulativeNav,
  yearNav: OVERVIEW.yearNav,
  format: { thousands: true, abbreviate: false },
  navDecimals: 4,
  xirrDecimals: 2,
});

function installJsdomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = (): void => {};
  }
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// 定位工具
// ---------------------------------------------------------------------------
/** 按 Section 标题（h2）取 `<section>` 容器 */
function sectionByTitle(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const el = heading.closest('section');
  expect(el, `未找到标题为「${title}」的 section`).not.toBeNull();
  return el as HTMLElement;
}

/** Section 除标题行外的内容子节点（标题行恒为第 0 个） */
function sectionBody(section: HTMLElement): HTMLElement[] {
  return (Array.from(section.children) as HTMLElement[]).slice(1);
}

/** 按 SectionTitle（h3 小标题）取所在分组容器 */
function groupByTitle(title: string): HTMLElement {
  const heading = screen.getByText(title);
  expect(heading.tagName).toBe('H3');
  return heading.parentElement as HTMLElement;
}

/** 取分组内的卡片网格 */
function gridOf(group: HTMLElement): HTMLElement {
  const grid = group.querySelector('div.grid');
  expect(grid, '分组内未找到卡片网格').not.toBeNull();
  return grid as HTMLElement;
}

/** 按卡片标题取 StatCard 根节点（StatCard 是唯一带 overflow-hidden 的 Card） */
function statCardByTitle(title: string): HTMLElement {
  const el = screen.getByText(title).closest('.overflow-hidden');
  expect(el, `未找到标题为「${title}」的指标卡`).not.toBeNull();
  return el as HTMLElement;
}

/** a 是否严格排在 b 之前（文档顺序） */
function isBefore(a: Node, b: Node): boolean {
  return Boolean(
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('DashboardPage 布局打磨（f1013f3）', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    // useUrlState 直接读写 window.location，跨用例会泄漏，逐例复位
    window.history.replaceState(null, '', '/');
    state.portfolios = [PORTFOLIO];
    state.cashBalance = { amount: '5000.00', asOf: '2026-06-15' };
    apiMocks.getOverview.mockReset().mockResolvedValue(OVERVIEW);
    apiMocks.getPortfoliosSummary.mockReset().mockResolvedValue([]);
    apiMocks.listTransactions
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 5 });
    usePortfolioStore.setState({
      portfolios: [PORTFOLIO],
      currentPortfolioId: 'pf-1',
    });
    usePreferenceStore.setState({ preferences: BASE_PREF, loaded: true });
  });

  afterEach(() => {
    cleanup();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    usePortfolioStore.setState({ portfolios: [], currentPortfolioId: null });
    vi.clearAllMocks();
  });

  // ===== L-01 页面分区 =====
  describe('L-01 页面分区（Section）', () => {
    it('存在「关键指标」「趋势分析」两个 section，且前者在前', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const metrics = sectionByTitle('关键指标');
      const trends = sectionByTitle('趋势分析');

      expect(metrics.tagName).toBe('SECTION');
      expect(trends.tagName).toBe('SECTION');
      expect(metrics).not.toBe(trends);
      expect(isBefore(metrics, trends)).toBe(true);
    });

    it('区标题是 h2，区描述以 p 渲染（不引入交互元素）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByText('关键指标').tagName).toBe('H2');
      expect(screen.getByText('趋势分析').tagName).toBe('H2');
      expect(screen.getByText('资产家底与收益表现一眼看全').tagName).toBe('P');
      expect(
        screen.getByText('维度与区间对本区所有图表统一生效').tagName,
      ).toBe('P');
    });

    it('两个 section 同属外层 space-y-8 容器（区间留白）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const metrics = sectionByTitle('关键指标');
      const trends = sectionByTitle('趋势分析');

      expect(metrics.parentElement).toBe(trends.parentElement);
      expect(metrics.parentElement?.className).toContain('space-y-8');
    });

    it('全页仅这 2 个 section，不额外套壳', async () => {
      const { container } = renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(container.querySelectorAll('section')).toHaveLength(2);
    });
  });

  // ===== L-02 8 卡分组 =====
  describe('L-02 8 卡按 group 拆成两组', () => {
    it('「关键指标」区内恰含「资产构成」「收益表现」两个分组小标题', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const section = sectionByTitle('关键指标');
      const body = sectionBody(section);

      expect(body).toHaveLength(2);
      expect(body[0].querySelector('h3')?.textContent).toBe('资产构成');
      expect(body[1].querySelector('h3')?.textContent).toBe('收益表现');
    });

    it('资产构成 4 张卡，标题与顺序对齐 buildOverviewMetrics 的 asset 组', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const grid = gridOf(groupByTitle('资产构成'));
      const expected = EXPECTED_METRICS.filter((m) => m.group === 'asset');

      expect(expected).toHaveLength(4);
      expect(grid.children).toHaveLength(4);
      expect(
        Array.from(grid.children).map(
          (c) => c.querySelector('h3')?.textContent,
        ),
      ).toEqual(expected.map((m) => m.title));
    });

    it('收益表现 4 张卡，标题与顺序对齐 buildOverviewMetrics 的 return 组', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const grid = gridOf(groupByTitle('收益表现'));
      const expected = EXPECTED_METRICS.filter((m) => m.group === 'return');

      expect(expected).toHaveLength(4);
      expect(grid.children).toHaveLength(4);
      expect(
        Array.from(grid.children).map(
          (c) => c.querySelector('h3')?.textContent,
        ),
      ).toEqual(expected.map((m) => m.title));
    });

    it('🔴 两组拼起来恰是原始 8 张卡：不重复、不遗漏、不改序', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const titles = [
        ...Array.from(gridOf(groupByTitle('资产构成')).children),
        ...Array.from(gridOf(groupByTitle('收益表现')).children),
      ].map((c) => c.querySelector('h3')?.textContent);

      expect(titles).toHaveLength(8);
      expect(titles).toEqual(EXPECTED_METRICS.map((m) => m.title));
      expect(new Set(titles).size).toBe(8);
    });

    it('🔴「当前总资产」全页只出现 1 次（分组不得复制卡片）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getAllByText('当前总资产')).toHaveLength(1);
    });

    it('🔴 8 卡的值仍逐项来自 buildOverviewMetrics（asset-metrics 未被绕开）', async () => {
      renderDashboard();
      await screen.findByText('¥123,456.78');

      for (const m of EXPECTED_METRICS) {
        const card = statCardByTitle(m.title);
        expect(card.textContent, `「${m.title}」卡的值`).toContain(m.value);
        if (m.description) {
          expect(card.textContent).toContain(m.description);
        }
      }
    });

    it('🔴 涨跌方向未被分组改写：正值出涨箭头、负值出跌箭头、金额类无箭头', async () => {
      renderDashboard();
      await screen.findByText('¥123,456.78');

      // 夹具：累计收益率 +23.45%（up）/ 当年收益率 -5%（down）
      expect(EXPECTED_METRICS.find((m) => m.key === 'total-return-rate')?.trend)
        .toBe('up');
      expect(EXPECTED_METRICS.find((m) => m.key === 'year-return-rate')?.trend)
        .toBe('down');

      const up = statCardByTitle('累计收益率').querySelector('svg');
      const down = statCardByTitle('当年收益率').querySelector('svg');
      expect(up?.getAttribute('class')).toContain('text-red-600');
      expect(down?.getAttribute('class')).toContain('text-emerald-600');

      // 金额类恒 neutral → 卡头无箭头图标
      expect(statCardByTitle('当前总资产').querySelector('svg')).toBeNull();
      expect(statCardByTitle('净投入').querySelector('svg')).toBeNull();
    });
  });

  // ===== L-03 首卡描边 =====
  describe('L-03 首张「当前总资产」轻描边', () => {
    it('「当前总资产」卡带 border-primary/30', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(
        statCardByTitle('当前总资产').classList.contains('border-primary/30'),
      ).toBe(true);
    });

    it('🔴 其余 7 张卡不得带该描边（否则强调失效）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      for (const m of EXPECTED_METRICS) {
        if (m.key === 'total-asset') continue;
        expect(
          statCardByTitle(m.title).classList.contains('border-primary/30'),
          `「${m.title}」不应带强调描边`,
        ).toBe(false);
      }
    });
  });

  // ===== L-04 网格断点 =====
  describe('L-04 卡片网格响应式断点', () => {
    it('两组网格均为 grid-cols-1 / sm:grid-cols-2 / md:grid-cols-4', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      for (const name of ['资产构成', '收益表现']) {
        const cls = gridOf(groupByTitle(name)).className;
        expect(cls, name).toContain('grid-cols-1');
        expect(cls, name).toContain('sm:grid-cols-2');
        expect(cls, name).toContain('md:grid-cols-4');
        expect(cls, name).toContain('gap-4');
      }
    });

    it('🔴 两组共用完全相同的网格类（两行卡片列宽严格对齐的前提）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(gridOf(groupByTitle('资产构成')).className).toBe(
        gridOf(groupByTitle('收益表现')).className,
      );
    });

    it('移动端不排 2 列：网格类中不出现无断点前缀的 grid-cols-2', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const tokens = gridOf(groupByTitle('资产构成')).className.split(/\s+/);
      expect(tokens).not.toContain('grid-cols-2');
      expect(tokens).toContain('grid-cols-1');
    });
  });

  // ===== L-05 / L-06 趋势区 =====
  describe('L-05/L-06 趋势分析区结构', () => {
    it('🔴 区内顺序为 筛选栏 → hero 走势图 → 四宫格', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const body = sectionBody(sectionByTitle('趋势分析'));
      expect(body).toHaveLength(3);

      const [filterBar, hero, quad] = body;

      // 筛选栏：含维度 Tabs 与唯一的日期选择器
      expect(filterBar.contains(screen.getByRole('tab', { name: '月' }))).toBe(
        true,
      );
      expect(filterBar.contains(screen.getByRole('combobox'))).toBe(true);

      // hero 走势图
      expect(hero.getAttribute('data-testid')).toBe('total-asset-trend-chart');

      // 四宫格：净值趋势 / XIRR 趋势 / 近期出入金 / 组合表现对比
      expect(quad.contains(screen.getByTestId('nav-chart'))).toBe(true);
      expect(quad.contains(screen.getByTestId('xirr-chart'))).toBe(true);
      expect(quad.textContent).toContain('近期出入金');
      expect(quad.textContent).toContain('组合表现对比');
      expect(quad.children).toHaveLength(4);
    });

    it('筛选栏移动端纵向堆叠、≥sm 一行且日期选择器靠左（无 justify-between，与其他分析页一致）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const cls = sectionBody(sectionByTitle('趋势分析'))[0].className;
      expect(cls).toContain('flex-col');
      expect(cls).toContain('sm:flex-row');
      // ≥sm 允许换行，且各控件底边对齐（d99c8a8：items-center→items-end 的核心行为，
      //  此前无任何用例锁定，改动二又恰好重写了这串 class → 补锁防回归）
      expect(cls).toContain('sm:flex-wrap');
      expect(cls).toContain('sm:items-end');
      // 改动二：删除 sm:justify-between，维度 Tabs 与日期选择器靠左紧凑排列
      expect(cls).not.toContain('sm:justify-between');
      expect(cls).toContain('gap-4');
      expect(cls).not.toContain('gap-3');
    });

    it('筛选栏内维度 Tabs 在前、日期选择器紧随其后，且全页仅一个范围选择器', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const bar = sectionBody(sectionByTitle('趋势分析'))[0];
      const children = Array.from(bar.children) as HTMLElement[];
      expect(children).toHaveLength(2);

      // 第 0 个：维度 Tabs（[日][周][月][年]）
      expect(children[0].textContent).toContain('日');
      expect(children[0].querySelector('[role="tablist"]')).not.toBeNull();

      // 第 1 个：DateRangeQuickPicker（范围下拉 + 起止日期）
      expect(children[1].querySelector('[role="combobox"]')).not.toBeNull();

      // 删除 justify-between 后不得引入第二个选择器（A8 单数断言的前提）
      expect(screen.getAllByRole('combobox')).toHaveLength(1);
    });

    it('三张时序图（hero + 净值 + XIRR）收在同一个「趋势分析」区内', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const trends = sectionByTitle('趋势分析');
      expect(trends.contains(screen.getByTestId('total-asset-trend-chart')))
        .toBe(true);
      expect(trends.contains(screen.getByTestId('nav-chart'))).toBe(true);
      expect(trends.contains(screen.getByTestId('xirr-chart'))).toBe(true);

      // 指标卡不得漏进趋势区
      expect(trends.contains(statCardByTitle('当前总资产'))).toBe(false);
    });

    it('空数据 → 四宫格位置换成三步引导卡，筛选栏与 hero 图仍在', async () => {
      apiMocks.getOverview.mockResolvedValue(null);

      renderDashboard();
      await screen.findByText('开始记录你的投资');

      const body = sectionBody(sectionByTitle('趋势分析'));
      expect(body).toHaveLength(3);
      expect(body[0].contains(screen.getByRole('combobox'))).toBe(true);
      expect(body[1].getAttribute('data-testid')).toBe(
        'total-asset-trend-chart',
      );
      expect(body[2].textContent).toContain('开始记录你的投资');
      expect(screen.queryByTestId('nav-chart')).toBeNull();
    });
  });

  // ===== L-07 combobox 单数护栏 =====
  describe('L-07 Section / SectionTitle 未引入新 combobox', () => {
    it('🔴 全页 combobox 恰为 1 个（DateRangeQuickPicker）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getAllByRole('combobox')).toHaveLength(1);
    });

    it('「关键指标」区内不含任何 combobox / select', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const metrics = sectionByTitle('关键指标');
      expect(metrics.querySelectorAll('[role="combobox"]')).toHaveLength(0);
      expect(metrics.querySelectorAll('select')).toHaveLength(0);
    });
  });
});
