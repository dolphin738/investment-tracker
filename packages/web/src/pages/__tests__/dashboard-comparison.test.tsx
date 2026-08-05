/**
 * pages/dashboard.tsx —「组合表现对比」补列 验收（Q-4 甲 · 阶段 B / DASH-P1-01）
 *
 * 背景：后端 /portfolios/summary 此前不返回 cumulativeReturnRate / xirr，
 * 前端 `p.cumulativeReturnRate != null && (...)` 恒为假 —— 这两列是**死分支**。
 * 阶段 B 后端补列后本用例验证其「转正」：
 * - 真实渲染累计收益率（正红 text-up / 负绿 text-down）与 XIRR 两列
 * - 后端返回的是 **8 位小数字符串**（非 number），不得渲染出 NaN%
 * - 小数位随偏好 xirrDecimals 联动
 * - null（尚无 DailyNav / DailyXirr）与 undefined（旧后端）均不得渲染成 0
 * - xirr === '0.00000000' 属有效值，必须照常渲染（不得被判空吞掉）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Portfolio } from '@investment-tracker/shared';
import type {
  OverviewResponse,
  PortfolioSummary,
  UserPreference,
} from '@/api/types';

const state = vi.hoisted(() => ({ portfolios: [] as unknown[] }));

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

vi.mock('@/components/charts/nav-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    NavTrendChart: () => createElement('div', { 'data-testid': 'nav-chart' }),
  };
});
vi.mock('@/components/charts/xirr-trend-chart', async () => {
  const { createElement } = await import('react');
  return {
    XirrTrendChart: () => createElement('div', { 'data-testid': 'xirr-chart' }),
  };
});
vi.mock('@/features/cashflow/cashflow-form', async () => {
  const { createElement } = await import('react');
  return { CashflowForm: () => createElement('div') };
});
vi.mock('@/features/security-trade/security-trade-form', async () => {
  const { createElement } = await import('react');
  return { SecurityTradeForm: () => createElement('div') };
});

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
  latestSource: 'MANUAL',
  holdingsSummary: {
    totalMarketValue: '123456.78',
    totalCost: '100000.00',
    totalProfit: '23456.78',
    securityCount: 3,
  },
  recentTransactions: [],
};

/** 组合摘要行工厂（后端 Q-4 甲 形态：8 位小数**字符串**） */
function makeSummary(
  overrides: Partial<PortfolioSummary> = {},
): PortfolioSummary {
  return {
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
    cumulativeReturnRate: '0.23450000',
    xirr: '0.08210000',
    netInvested: '100000.00',
    floatingProfit: '23456.78',
    ...overrides,
  } as PortfolioSummary;
}

const BASE_PREF = {
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
    Element.prototype.scrollIntoView = function (): void {};
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
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

/** 拿到「组合表现对比」卡片容器 */
async function findComparisonCard(): Promise<HTMLElement> {
  const title = await screen.findByText('组合表现对比');
  // Card > CardHeader(title) + CardContent
  const card = title.closest('div')?.parentElement as HTMLElement;
  expect(card).toBeTruthy();
  return card;
}

/** 拿到某个组合在对比卡中的那一行 */
async function findRow(name: string): Promise<HTMLElement> {
  const card = await findComparisonCard();
  const nameNode = await within(card).findByText(name);
  return nameNode.parentElement as HTMLElement;
}

/** 挂载页面并定位对比卡中的目标行（夹具在调用前设置） */
async function mountAndFindRow(name = '测试组合'): Promise<HTMLElement> {
  renderDashboard();
  return findRow(name);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe('DashboardPage 组合表现对比补列（Q-4 甲）', () => {
  beforeEach(() => {
    installJsdomPolyfills();
    state.portfolios = [PORTFOLIO];
    apiMocks.getOverview.mockReset().mockResolvedValue(OVERVIEW);
    apiMocks.listTransactions
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 5 });
    apiMocks.getPortfoliosSummary.mockReset().mockResolvedValue([makeSummary()]);
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

  // ===== 两列真实渲染（死分支转正）=====
  describe('两列渲染', () => {
    it('【关键】累计收益率列真实渲染（此前恒为死分支，不渲染任何内容）', async () => {
      const row = await mountAndFindRow();

      await waitFor(() => {
        expect(row.textContent).toContain('23.45%');
      });
    });

    it('【关键】XIRR 列真实渲染，带 "XIRR" 前缀', async () => {
      const row = await mountAndFindRow();

      await waitFor(() => {
        expect(row.textContent).toContain('XIRR 8.21%');
      });
    });

    it('字符串比率不产生 NaN%（后端返回的是 8 位小数字符串而非 number）', async () => {
      const row = await mountAndFindRow();

      await waitFor(() => expect(row.textContent).toContain('23.45%'));
      expect(row.textContent).not.toContain('NaN');
    });

    it('多组合各渲染各的两列，不串值', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({
          id: 'pf-1',
          name: 'A组合',
          cumulativeReturnRate: '0.10000000',
          xirr: '0.01000000',
        }),
        makeSummary({
          id: 'pf-2',
          name: 'B组合',
          cumulativeReturnRate: '-0.20000000',
          xirr: '-0.02000000',
        }),
      ]);

      renderDashboard();
      const rowA = await findRow('A组合');
      const rowB = await findRow('B组合');

      await waitFor(() => {
        expect(rowA.textContent).toContain('10.00%');
        expect(rowA.textContent).toContain('XIRR 1.00%');
        expect(rowB.textContent).toContain('-20.00%');
        expect(rowB.textContent).toContain('XIRR -2.00%');
      });
    });
  });

  // ===== 正红负绿（PRD §9.5 A股色）=====
  describe('涨跌色（正红负绿）', () => {
    it('正收益率 → text-up', async () => {
      const row = await mountAndFindRow();

      await waitFor(() => {
        const span = within(row).getByText('23.45%');
        expect(span.className).toContain('text-up');
        expect(span.className).not.toContain('text-down');
      });
    });

    it('【关键】负收益率 → text-down（旧 `p.x >= 0` 分支从未被执行过）', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({ cumulativeReturnRate: '-0.12350000' }),
      ]);

      const row = await mountAndFindRow();

      await waitFor(() => {
        const span = within(row).getByText('-12.35%');
        expect(span.className).toContain('text-down');
        expect(span.className).not.toContain('text-up');
      });
    });

    it('零收益率 → 归入 text-up（>= 0 边界）', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({ cumulativeReturnRate: '0.00000000' }),
      ]);

      const row = await mountAndFindRow();

      await waitFor(() => {
        const span = within(row).getByText('0.00%');
        expect(span.className).toContain('text-up');
      });
    });

    it('极小负值（-0.00000001）仍判为负 → text-down（字符串未被误判为 0）', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({ cumulativeReturnRate: '-0.00000001' }),
      ]);

      const row = await mountAndFindRow();

      await waitFor(() => {
        const span = within(row).getByText('-0.00%');
        expect(span.className).toContain('text-down');
      });
    });
  });

  // ===== 小数位联动 xirrDecimals =====
  describe('小数位随偏好 xirrDecimals 联动', () => {
    it('xirrDecimals=4 → 两列均显示 4 位小数', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, xirrDecimals: 4 } as UserPreference,
        loaded: true,
      });

      const row = await mountAndFindRow();

      await waitFor(() => {
        expect(row.textContent).toContain('23.4500%');
        expect(row.textContent).toContain('XIRR 8.2100%');
      });
    });

    it('xirrDecimals=0 → 两列均显示整数百分比', async () => {
      usePreferenceStore.setState({
        preferences: { ...BASE_PREF, xirrDecimals: 0 } as UserPreference,
        loaded: true,
      });

      const row = await mountAndFindRow();

      await waitFor(() => {
        expect(row.textContent).toContain('23%');
        expect(row.textContent).toContain('XIRR 8%');
      });
    });
  });

  // ===== 判空语义：null / undefined 不得渲染成 0 =====
  describe('判空语义（禁止渲染 0）', () => {
    it('【关键】cumulativeReturnRate=null（尚无 DailyNav）→ 不渲染 0.00%，也不渲染 NaN%', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({ cumulativeReturnRate: null, xirr: null }),
      ]);

      const row = await mountAndFindRow();
      await waitFor(() => expect(row.textContent).toContain('123,456.78'));

      expect(row.textContent).not.toContain('0.00%');
      expect(row.textContent).not.toContain('NaN');
      expect(row.textContent).not.toContain('XIRR');
    });

    it('【关键】字段为 undefined（旧后端）→ 不渲染 NaN%', async () => {
      const legacy = makeSummary();
      delete (legacy as Partial<PortfolioSummary>).cumulativeReturnRate;
      delete (legacy as Partial<PortfolioSummary>).xirr;
      apiMocks.getPortfoliosSummary.mockResolvedValue([legacy]);

      const row = await mountAndFindRow();
      await waitFor(() => expect(row.textContent).toContain('123,456.78'));

      expect(row.textContent).not.toContain('NaN');
      expect(row.textContent).not.toContain('%');
    });

    it('【关键】xirr="0.00000000" 是有效值，必须照常渲染（不得被判空吞掉）', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({ xirr: '0.00000000' }),
      ]);

      const row = await mountAndFindRow();

      await waitFor(() => {
        expect(row.textContent).toContain('XIRR 0.00%');
      });
    });

    it('cumulativeReturnRate 有值但 xirr 为 null → 只渲染收益率列', async () => {
      apiMocks.getPortfoliosSummary.mockResolvedValue([
        makeSummary({ xirr: null }),
      ]);

      const row = await mountAndFindRow();

      await waitFor(() => expect(row.textContent).toContain('23.45%'));
      expect(row.textContent).not.toContain('XIRR');
    });
  });
});
