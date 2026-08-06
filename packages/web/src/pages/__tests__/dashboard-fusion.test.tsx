/**
 * pages/dashboard.tsx — 总资产概览融合页面级验收（T05 · QA）
 *
 * 组件级口径已由 `features/overview/__tests__/asset-metrics.test.ts` 与
 * `total-asset-trend-chart.test.tsx` 覆盖；本文件补的是**页面装配**这一层，
 * 即「概览页确实按设计把它们接上了」：
 *
 * - N-01 指标卡由 6 张扩为 8 张，且「当前总资产」全页只出现 1 次（融合去重）
 * - N-02 8 张卡的标题/顺序与 `buildOverviewMetrics` 逐项一致（页面未私改）
 * - N-03 总资产走势图已插入，且拿到与净值序列同源的 data
 * - N-04 走势图区间跟随页面日期筛选（切快捷范围后 from/to 同步变化）
 * - N-05 范围筛选器全页只有 1 个 combobox（原 Select 是被**替换**而非并存）
 * - N-06 现金余额卡取 `useLatestCashBalance`，余额恰好为 0 时显示 ¥0.00
 *
 * 策略：stub 掉 TotalAssetTrendChart 以捕获其 props（页面装配的观测点），
 * 图表自身渲染由组件级用例负责，避免 jsdom 里跑真 ECharts。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type { OverviewResponse, UserPreference } from '@/api/types';

// ---------------------------------------------------------------------------
// 夹具槽
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  portfolios: [] as unknown[],
  /** 捕获 TotalAssetTrendChart 每次收到的 props */
  trendProps: [] as Array<Record<string, unknown>>,
  /** 捕获 useNavSeries 收到的查询参数 */
  navParams: [] as Array<Record<string, unknown>>,
  /** useLatestCashBalance 返回值 */
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
    useNavSeries: (_pid: unknown, params: Record<string, unknown>) => {
      state.navParams.push(params);
      return idle;
    },
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

// 走势图替身：只记录 props（页面装配的观测点），不跑真 ECharts
vi.mock('@/features/overview/total-asset-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    TotalAssetTrendChart: (props: Record<string, unknown>) => {
      state.trendProps.push(props);
      return createElement(
        'div',
        { 'data-testid': 'total-asset-trend-chart' },
        '总资产走势',
      );
    },
  };
});

vi.mock('@/components/charts/nav-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    NavTrendChart: () =>
      createElement('div', { 'data-testid': 'nav-chart' }, '净值趋势'),
  };
});
vi.mock('@/components/charts/xirr-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    XirrTrendChart: () =>
      createElement('div', { 'data-testid': 'xirr-chart' }, 'XIRR 趋势'),
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
import { resolveQuickRange } from '@/features/query/dimension-switcher';

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
  yearNav: '1.050000',
  xirr: '0.0821',
  netInvested: '100000.00',
  totalReturnRate: '0.23450000',
  yearReturnRate: '0.05000000',
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

/** 取最近一次走势图 props */
function lastTrendProps(): Record<string, unknown> {
  return state.trendProps[state.trendProps.length - 1];
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('DashboardPage 总资产概览融合（页面级验收）', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    // 🔴 useUrlState 直接读写 window.location + history.replaceState（不走
    // MemoryRouter），URL 状态会跨用例泄漏 —— 改过起止日期的用例会把
    // `?range=custom&from=…` 留给下一个用例。必须逐例复位。
    window.history.replaceState(null, '', '/');
    state.portfolios = [PORTFOLIO];
    state.trendProps = [];
    state.navParams = [];
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

  // ===== N-01 / N-02：8 张指标卡 =====
  describe('N-01/N-02 指标卡 6→8 且与 buildOverviewMetrics 一致', () => {
    it('渲染 8 张卡，标题与顺序逐项对齐 buildOverviewMetrics', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      // 期望顺序由被测口径函数产出（而非在用例里硬抄一份，避免双份真相）
      const expected = buildOverviewMetrics({}).map((m) => m.title);
      expect(expected).toHaveLength(8);

      for (const title of expected) {
        expect(screen.getByText(title)).toBeDefined();
      }
    });

    it('资产构成 4 项与收益表现 4 项均在页面上', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      for (const t of ['当前总资产', '持仓市值', '现金余额', '净投入']) {
        expect(screen.getByText(t)).toBeDefined();
      }
      for (const t of ['累计收益率', '当年收益率', '年化 XIRR', '累计净值']) {
        expect(screen.getByText(t)).toBeDefined();
      }
    });

    it('🔴「当前总资产」全页只出现 1 次（融合去重的核心目的）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getAllByText('当前总资产')).toHaveLength(1);
    });

    it('持仓市值取 holdingsSummary.totalMarketValue，不与总资产混淆', async () => {
      renderDashboard();

      // 必须等 overview query settle —— nav-chart 在 loading 阶段就已挂载，
      // 用它当锚点会在数据到达前就断言，卡里还是「暂无数据」（假失败）
      // OVERVIEW 里两者被刻意设成不同值，混用会立刻暴露
      expect(await screen.findByText('¥123,456.78')).toBeDefined(); // totalAsset
      expect(screen.getByText('¥98,000.00')).toBeDefined(); // marketValue
    });
  });

  // ===== N-06：现金余额卡 =====
  describe('N-06 现金余额卡', () => {
    it('取 useLatestCashBalance 的金额与生效日', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByText('¥5,000.00')).toBeDefined();
      expect(screen.getByText('生效日 2026-06-15')).toBeDefined();
    });

    it('🔴 余额恰好为 0 → 显示 ¥0.00 而非「暂无数据」', async () => {
      state.cashBalance = { amount: '0', asOf: '2026-06-15' };

      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByText('¥0.00')).toBeDefined();
    });

    it('从未维护过 → 「暂无数据」+ 引导文案', async () => {
      state.cashBalance = null;

      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByText('未维护，可在出入金页录入')).toBeDefined();
    });
  });

  // ===== N-03 / N-04：总资产走势图装配 =====
  describe('N-03/N-04 总资产走势图', () => {
    it('走势图已插入概览页', async () => {
      renderDashboard();
      expect(await screen.findByTestId('total-asset-trend-chart')).toBeDefined();
    });

    it('区间与净值序列查询同源（走势图 from/to == useNavSeries 入参）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const nav = state.navParams[state.navParams.length - 1];
      const trend = lastTrendProps();
      expect(trend.startDate).toBe(nav.startDate);
      expect(trend.endDate).toBe(nav.endDate);
      expect(trend.portfolioId).toBe('pf-1');
    });

    it('默认偏好 1y → 区间为近 1 年', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const expectedRange = resolveQuickRange('1y');
      expect(lastTrendProps().startDate).toBe(expectedRange.startDate);
    });

    /**
     * 快捷范围走「偏好驱动初值」而非点开 Radix Select ——
     * jsdom 下 Radix 的 Portal + 指针事件不可靠，既有
     * `date-range-quick-picker.test.tsx` 同样规避了开合下拉。
     * 这里验证的是「range 变化 → 走势图区间变化」这条数据链路，
     * 用哪种方式触发 range 变化并不影响判别力。
     */
    it('🔴 范围为「全部」→ 走势图起点取组合成立日，而非兜底 2000-01-01', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: 'all' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      // PORTFOLIO.baseDate = '2024-01-01'
      expect(lastTrendProps().startDate).toBe('2024-01-01');
      expect(lastTrendProps().startDate).not.toBe('2000-01-01');
      // 与近 1 年（默认）明显不同，证明区间确实跟随 range 变化
      expect(lastTrendProps().startDate).not.toBe(
        resolveQuickRange('1y').startDate,
      );
      // 净值序列查询同步跟进（两图同源）
      expect(state.navParams[state.navParams.length - 1].startDate).toBe(
        '2024-01-01',
      );
    });

    it('范围为「近1月」→ 区间收窄，走势图与序列查询同步', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: '1m' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      const expected = resolveQuickRange('1m');
      expect(lastTrendProps().startDate).toBe(expected.startDate);
      expect(state.navParams[state.navParams.length - 1].startDate).toBe(
        expected.startDate,
      );
    });

    it('🔴 手动改起始日（自定义区间）→ 走势图与序列查询随 from 重新拉取', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const before = lastTrendProps().startDate;
      expect(before).toBe(resolveQuickRange('1y').startDate);

      // Act：直接编辑起始日期输入（自定义区间路径）
      const startInput = document.querySelectorAll('input[type="date"]')[0];
      fireEvent.change(startInput, { target: { value: '2025-03-01' } });

      // Assert：走势图与净值序列同步收到新起点
      await waitFor(() => {
        expect(lastTrendProps().startDate).toBe('2025-03-01');
      });
      expect(lastTrendProps().startDate).not.toBe(before);
      expect(state.navParams[state.navParams.length - 1].startDate).toBe(
        '2025-03-01',
      );
    });

    it('🔴 手动改结束日 → 走势图与序列查询随 to 重新拉取', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const startInput = document.querySelectorAll('input[type="date"]')[0];
      fireEvent.change(startInput, { target: { value: '2025-03-01' } });
      await waitFor(() => {
        expect(lastTrendProps().startDate).toBe('2025-03-01');
      });

      const endInput = document.querySelectorAll('input[type="date"]')[1];
      fireEvent.change(endInput, { target: { value: '2025-09-30' } });

      await waitFor(() => {
        expect(lastTrendProps().endDate).toBe('2025-09-30');
      });
      expect(state.navParams[state.navParams.length - 1].endDate).toBe(
        '2025-09-30',
      );
    });

    it('长区间（>1 年，组合成立日至今）渲染不崩', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: 'all' },
        loaded: true,
      });

      renderDashboard();

      expect(await screen.findByTestId('total-asset-trend-chart')).toBeDefined();
      expect(screen.getAllByText('当前总资产')).toHaveLength(1);
    });

    it('金额格式化偏好透传给走势图', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(lastTrendProps().amountThousands).toBe(true);
      expect(lastTrendProps().amountAbbrev).toBe(false);
    });
  });

  // ===== N-05：范围选择器唯一 =====
  describe('N-05 范围筛选器唯一性', () => {
    it('🔴 全页只有 1 个 combobox（原 Select 被替换而非并存）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getAllByRole('combobox')).toHaveLength(1);
    });

    it('受控回显：偏好 1y → 触发器显示「近1年」', async () => {
      renderDashboard();

      // Radix SelectValue 的文案在 item 注册完成后才落 DOM，需等一拍
      await waitFor(() => {
        expect(screen.getByRole('combobox').textContent).toContain('近1年');
      });
    });

    it('提供起止日期输入（自定义区间入口）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByText('起始日期')).toBeDefined();
      expect(screen.getByText('结束日期')).toBeDefined();
    });
  });
});
