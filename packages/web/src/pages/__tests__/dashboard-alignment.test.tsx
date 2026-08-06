/**
 * pages/dashboard.tsx — 阶段 A 对齐验收（A6~A8）
 *
 * 覆盖验证项：
 * - A6 近期出入金卡「查看全部」→ /cashflows（DASH-P0-05）
 * - A7 有组合无数据 → 三步引导卡替换四宫格（DASH-P0-06）；
 *      **重点验证 hasNoData 排除 isError**：请求失败不得伪装成空态
 * - A8 范围下拉复用共享 QUICK_RANGE_OPTIONS（7 项）+ resolveQuickRange，
 *      且解析结果确实下发到 nav/xirr 序列查询参数
 *
 * 测试策略：mock API 层与重型图表，保留真实 QueryClient（走真实 loading→success/error
 * 状态机），这样 hasNoData 的三态判定才是真在测，而不是测桩。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type {
  OverviewResponse,
  PortfolioSummary,
  UserPreference,
} from '@/api/types';

// ---------------------------------------------------------------------------
// 夹具槽
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  portfolios: [] as unknown[],
  /** 记录 useNavSeries / useXirrSeries 收到的查询参数 */
  seriesParams: [] as Array<Record<string, unknown>>,
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

// 序列 hooks：记录参数并返回稳定空结果（图表已被替身接管）
vi.mock('@/hooks/use-query-data', () => {
  const idle = {
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  return {
    useXirrSeries: (_pid: unknown, params: Record<string, unknown>) => {
      state.seriesParams.push(params);
      return idle;
    },
    useNavSeries: (_pid: unknown, params: Record<string, unknown>) => {
      state.seriesParams.push(params);
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

// ECharts 图表替身（jsdom 无 canvas）
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
    CashflowForm: () =>
      createElement('div', { 'data-testid': 'cashflow-form' }),
  };
});
vi.mock('@/features/security-trade/security-trade-form', async () => {
  const { createElement } = await import('react');
  return {
    SecurityTradeForm: () => createElement('div', { 'data-testid': 'trade-form' }),
  };
});

// 必须在 vi.mock 之后导入
import DashboardPage from '@/pages/dashboard';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
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
    totalMarketValue: '123456.78',
    totalCost: '100000.00',
    totalProfit: '23456.78',
    securityCount: 3,
  },
  recentTransactions: [],
};

const SUMMARY: PortfolioSummary[] = [
  {
    id: 'pf-1',
    name: '测试组合',
    totalAsset: '123456.78',
    holdingsCount: 3,
    lastUpdatedAt: '2026-06-15',
    baseDate: '2024-01-01',
    currency: 'CNY',
    createdAt: '2024-01-01T00:00:00.000Z',
    cumulativeNav: '1.234500',
    yearReturnRate: '0.05000000',
    netInvested: '100000.00',
    floatingProfit: '23456.78',
  },
];

const TRANSACTIONS = {
  items: [
    {
      id: 'tx-1',
      portfolioId: 'pf-1',
      date: '2026-06-10',
      type: 'BUY',
      amount: '10000.00',
      note: '定投',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 5,
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

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
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

/**
 * 等待 overview 查询真正落到目标状态。
 *
 * 必要性：`hasNoData` 在 isLoading 阶段同样为 false，四宫格会先渲染出来，
 * 若直接断言「引导卡不存在」会在 query 尚未 settle 时就通过 —— 那样即便源码
 * 漏掉 `!overview.isError`，用例也照样绿灯（假阴性）。因此必须显式等状态。
 */
async function waitOverviewStatus(
  queryClient: QueryClient,
  status: 'success' | 'error',
): Promise<void> {
  await waitFor(() => {
    expect(queryClient.getQueryState(['overview', 'pf-1'])?.status).toBe(
      status,
    );
  });
}

/** 独立实现「N 天前」，避免直接复用被测代码自证 */
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear().toString();
  const MM = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${yyyy}-${MM}-${dd}`;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('DashboardPage 阶段 A', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    state.portfolios = [PORTFOLIO];
    state.seriesParams = [];
    apiMocks.getOverview.mockReset().mockResolvedValue(OVERVIEW);
    apiMocks.getPortfoliosSummary.mockReset().mockResolvedValue(SUMMARY);
    apiMocks.listTransactions.mockReset().mockResolvedValue(TRANSACTIONS);
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

  // ===== A6：查看全部 =====
  describe('A6 近期出入金「查看全部」（DASH-P0-05）', () => {
    it('渲染指向 /cashflows 的链接', async () => {
      renderDashboard();

      const link = await screen.findByRole('link', { name: '查看全部' });
      expect(link.getAttribute('href')).toBe('/cashflows');
    });

    it('链接位于「近期出入金」卡片头部，而非组合表现对比卡', async () => {
      renderDashboard();

      const title = await screen.findByText('近期出入金');
      const header = title.closest('div');
      expect(header).not.toBeNull();
      expect(within(header as HTMLElement).getByText('查看全部')).toBeDefined();

      // 组合对比卡不应有「查看全部」
      expect(screen.getAllByText('查看全部')).toHaveLength(1);
    });
  });

  // ===== A7：三步引导 =====
  describe('A7 有组合无数据三步引导（DASH-P0-06）', () => {
    it('overview 返回空 → 渲染三步引导卡并替换四宫格', async () => {
      apiMocks.getOverview.mockResolvedValue(null);

      renderDashboard();

      expect(await screen.findByText('开始记录你的投资')).toBeDefined();
      expect(screen.getByText('创建组合')).toBeDefined();
      expect(screen.getByText('录入首笔存入')).toBeDefined();
      expect(screen.getByText('录入证券买卖 / 现价')).toBeDefined();

      // 四宫格被替换
      expect(screen.queryByTestId('nav-chart')).toBeNull();
      expect(screen.queryByTestId('xirr-chart')).toBeNull();
      expect(screen.queryByText('近期出入金')).toBeNull();
      expect(screen.queryByText('组合表现对比')).toBeNull();
    });

    it('空态下 6 指标卡与维度切换器照常渲染', async () => {
      apiMocks.getOverview.mockResolvedValue(null);

      renderDashboard();

      await screen.findByText('开始记录你的投资');

      for (const t of [
        '当前总资产',
        '累计收益率',
        '当年收益率',
        '年化 XIRR',
        '累计净值',
        '净投入',
      ]) {
        expect(screen.getByText(t)).toBeDefined();
      }
      expect(screen.getByRole('tab', { name: '月' })).toBeDefined();
    });

    it('引导卡内 2 个行动按钮可点开对应弹窗', async () => {
      apiMocks.getOverview.mockResolvedValue(null);

      renderDashboard();
      await screen.findByText('开始记录你的投资');

      const guideButtons = screen.getAllByRole('button', {
        name: /录入出入金|录入买卖/,
      });
      // 页头 2 个 + 引导卡 2 个
      expect(guideButtons.length).toBeGreaterThanOrEqual(4);
    });

    it('有数据 → 四宫格正常，不出现引导卡', async () => {
      const { queryClient } = renderDashboard();

      // 必须等 query settle，否则断言会落在 loading 阶段而失去判别力
      await waitOverviewStatus(queryClient, 'success');

      expect(screen.getByTestId('nav-chart')).toBeDefined();
      expect(screen.getByTestId('xirr-chart')).toBeDefined();
      expect(screen.getByText('近期出入金')).toBeDefined();
      expect(screen.getByText('组合表现对比')).toBeDefined();
      expect(screen.queryByText('开始记录你的投资')).toBeNull();
    });

    it('【关键】overview 请求失败 → 不得伪装成空态；四宫格仍渲染', async () => {
      apiMocks.getOverview.mockRejectedValue(new Error('boom'));

      const { queryClient } = renderDashboard();

      // 先等 overview 真正进入 error 状态，再断言（否则是假阴性）
      await waitOverviewStatus(queryClient, 'error');

      // hasNoData 排除 isError 的判据：错误 ≠ 空态
      expect(screen.queryByText('开始记录你的投资')).toBeNull();
      // 图表区仍在（latestNav 未失败，不进整页错误分支）
      expect(screen.getByTestId('nav-chart')).toBeDefined();
      expect(screen.getByText('近期出入金')).toBeDefined();
    });
  });

  // ===== A8：共享快捷范围 =====
  describe('A8 复用共享 QUICK_RANGE_OPTIONS / resolveQuickRange', () => {
    it('偏好 ytd → 触发器显示新文案「今年」（旧本地副本为「今年至今」）', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: 'ytd' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      const combo = screen.getByRole('combobox');
      expect(combo.textContent).toContain('今年');
      expect(combo.textContent).not.toContain('今年至今');
    });

    it('偏好 1w → 触发器显示「近一周」（该项仅存在于新 7 项列表）', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: '1w' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByRole('combobox').textContent).toContain('近一周');
    });

    it('偏好 6m → 触发器显示「近6月」', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: '6m' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(screen.getByRole('combobox').textContent).toContain('近6月');
    });

    it('1w 解析结果确实下发到净值/XIRR 序列查询参数（起=今天-7天，止=今天）', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: '1w' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      expect(state.seriesParams.length).toBeGreaterThan(0);
      const last = state.seriesParams[state.seriesParams.length - 1];
      expect(last.startDate).toBe(daysAgoIso(7));
      expect(last.endDate).toBe(daysAgoIso(0));
      // 与共享解析函数一致
      expect(last.startDate).toBe(resolveQuickRange('1w').startDate);
    });

    it('all 解析为组合首个交易日 baseDate 并下发查询参数（问题②）', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: 'all' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      const last = state.seriesParams[state.seriesParams.length - 1];
      // PORTFOLIO.baseDate = '2024-01-01'：不再是历史兜底值 2000-01-01
      expect(last.startDate).toBe('2024-01-01');
      expect(last.startDate).not.toBe('2000-01-01');
      expect(last.endDate).toBe(daysAgoIso(0));
    });

    it('all 且组合无 baseDate（尚无首笔买入）时回落 2000-01-01', async () => {
      usePortfolioStore.setState({
        portfolios: [{ ...PORTFOLIO, baseDate: null }],
        currentPortfolioId: 'pf-1',
      });
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: 'all' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      const last = state.seriesParams[state.seriesParams.length - 1];
      expect(last.startDate).toBe('2000-01-01');
      expect(last.endDate).toBe(daysAgoIso(0));
    });

    it('存量偏好为未知值时回落近1年，不产生空区间', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, defaultDateRange: 'legacy-unknown' },
        loaded: true,
      });

      renderDashboard();
      await screen.findByTestId('nav-chart');

      const last = state.seriesParams[state.seriesParams.length - 1];
      expect(last.startDate).toBe(resolveQuickRange('1y').startDate);
      expect(last.endDate).toBe(daysAgoIso(0));
      expect(last.startDate).toBeTruthy();
    });

    it('维度粒度仍从偏好读取并下发（回归 DASH-P0-02 验收2）', async () => {
      renderDashboard();
      await screen.findByTestId('nav-chart');

      const last = state.seriesParams[state.seriesParams.length - 1];
      expect(last.granularity).toBe('month');
    });
  });
});
