/**
 * pages/dashboard.tsx — Hooks 调用顺序回归（T05 · QA）
 *
 * 【为什么需要这个用例】
 * 概览融合（f5945ef）在 `dashboard.tsx` 中新增了 `overviewMetrics` 的 `useMemo`，
 * 但它位于三处提前 `return` 之后：
 *   - `if (portfoliosLoading) return …`   （L281）
 *   - `if (portfolios.length === 0) return …`（L291）
 *   - `if (!currentPortfolioId) return …` （L301）
 *
 * 于是「加载态渲染」与「加载完成渲染」的 Hook 数量不一致，触发 React 硬错误
 * `Rendered more hooks than during the previous render.`
 *
 * 既有 `dashboard-alignment.test.tsx` 把 `usePortfolios` 桩成恒定
 * `isLoading: false`，首帧就跳过了早退分支，因此**测不出**该缺陷。
 * 本用例专门让 `isLoading` 由 true→false 翻转，复现真实冷启动路径。
 *
 * 断言的是「行为」而非实现：组件在状态翻转后必须能正常渲染，不得抛错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type { OverviewResponse, UserPreference } from '@/api/types';

// ---------------------------------------------------------------------------
// 夹具槽
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  portfolios: [] as unknown[],
  /** 受控的组合列表加载态 —— 用于复现「冷启动 loading → 数据到达」 */
  portfoliosLoading: true,
}));

const apiMocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getPortfoliosSummary: vi.fn(),
  listTransactions: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// 关键：isLoading 从夹具槽实时读取，可在 render 之后翻转
vi.mock('@/hooks/use-portfolios', () => ({
  PORTFOLIOS_KEY: ['portfolios'],
  usePortfolios: () => ({
    data: state.portfolios,
    isLoading: state.portfoliosLoading,
  }),
}));

vi.mock('@/api/overview.api', () => ({
  getOverview: apiMocks.getOverview,
  getPortfoliosSummary: apiMocks.getPortfoliosSummary,
}));

vi.mock('@/api/transaction.api', () => ({
  listTransactions: apiMocks.listTransactions,
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

// ECharts 替身（jsdom 无 canvas）
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
    totalMarketValue: '123456.78',
    totalCost: '100000.00',
    totalProfit: '23456.78',
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
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('DashboardPage Hooks 调用顺序（融合回归）', () => {
  /** 捕获 React 抛出的错误（React 会 console.error 后再冒泡） */
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installJsdomPolyfills();
    // useUrlState 直接读写 window.location，跨用例会泄漏，逐例复位
    window.history.replaceState(null, '', '/');
    state.portfolios = [PORTFOLIO];
    state.portfoliosLoading = true;
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
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    usePreferenceStore.setState({ preferences: null, loaded: false });
    usePortfolioStore.setState({ portfolios: [], currentPortfolioId: null });
    vi.clearAllMocks();
  });

  it('【关键】组合列表 loading→loaded 翻转后仍能渲染，不触发 Hooks 数量变化错误', async () => {
    // Arrange：冷启动，组合列表尚在加载 → 命中 `if (portfoliosLoading)` 早退分支
    const { rerender, queryClient } = renderDashboard();
    expect(screen.getByText('加载中…')).toBeDefined();

    // Act：组合列表返回，重渲染 → 走到完整分支
    state.portfoliosLoading = false;
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Assert：8 指标卡正常渲染，且 React 未报 Hooks 顺序错误
    await waitFor(() => {
      expect(screen.getByText('当前总资产')).toBeDefined();
    });

    const hookOrderErrors = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => /Rendered more hooks|order of Hooks|Rules of Hooks/i.test(msg));
    expect(hookOrderErrors).toEqual([]);
  });

  it('【关键】未选组合→已选组合 翻转后仍能渲染，不触发 Hooks 数量变化错误', async () => {
    // Arrange：组合已加载但尚未选中 → 命中 `if (!currentPortfolioId)` 早退分支
    state.portfoliosLoading = false;
    usePortfolioStore.setState({
      portfolios: [PORTFOLIO],
      currentPortfolioId: null,
    });

    renderDashboard();
    expect(screen.getByText('请先在顶部选择一个投资组合')).toBeDefined();

    // Act：选中组合（store 更新自动触发重渲染）
    usePortfolioStore.setState({ currentPortfolioId: 'pf-1' });

    // Assert
    await waitFor(() => {
      expect(screen.getByText('当前总资产')).toBeDefined();
    });

    const hookOrderErrors = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => /Rendered more hooks|order of Hooks|Rules of Hooks/i.test(msg));
    expect(hookOrderErrors).toEqual([]);
  });
});
