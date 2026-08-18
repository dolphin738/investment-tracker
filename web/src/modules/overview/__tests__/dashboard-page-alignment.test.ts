/**
 * modules/overview/__tests__/dashboard-page-alignment.test.ts — 概览页对齐 React（§4.2）
 *
 * 平移自 React 版 dashboard-alignment / dashboard-comparison 高价值断言：
 * 1. 【关键】overview 请求失败 → 不得伪装成空态；四宫格仍渲染（A7）
 * 2. 组合表现对比：字符串比率不产生 NaN%；null 字段不渲染（NaN 防护）
 * 3. 涨跌色边界（正红负绿 §9.5）：正 → text-up；负 → text-down；零 → text-up；
 *    极小负值（-0.00000001 字符串）→ 仍判负 → text-down
 * 4. xirrDecimals 联动：对比两列小数位跟随偏好
 *
 * 脚手架与 dashboard-page.test.ts 一致（mock api 层 + 图表/弹窗子组件 stub，
 * Pinia/useUrlState/vue-router 真实）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import DashboardPage from '../pages/DashboardPage.vue';
import { getOverview, getPortfoliosSummary } from '@/api/overview.api';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import type { OverviewResponse, PortfolioSummary } from '@/api/types';
import type { Portfolio } from '@/lib/types';

const fixtures = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  overview: null as OverviewResponse | null,
  summary: [] as PortfolioSummary[],
  transactions: { items: [] as unknown[], total: 0, page: 1, pageSize: 5 },
  navSeries: [] as unknown[],
  xirrSeries: [] as unknown[],
  latestNav: null as unknown,
  latestXirr: null as unknown,
  latestBalance: null as unknown,
}));

vi.mock('@/api/portfolio.api', () => ({
  listPortfolios: vi.fn(async () => fixtures.portfolios),
  createPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  clearPortfolioData: vi.fn(),
  setDefaultPortfolio: vi.fn(),
}));

vi.mock('@/api/overview.api', () => ({
  getOverview: vi.fn(async () => fixtures.overview),
  getPortfoliosSummary: vi.fn(async () => fixtures.summary),
}));

vi.mock('@/api/transaction.api', () => ({
  listTransactions: vi.fn(async () => fixtures.transactions),
  createTransaction: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
}));

vi.mock('@/api/query.api', () => ({
  getNavSeries: vi.fn(async () => fixtures.navSeries),
  getXirrSeries: vi.fn(async () => fixtures.xirrSeries),
  getLatestNav: vi.fn(async () => fixtures.latestNav),
  getLatestXirr: vi.fn(async () => fixtures.latestXirr),
}));

vi.mock('@/api/cash-balance.api', () => ({
  listCashBalances: vi.fn(),
  getLatestCashBalance: vi.fn(async () => fixtures.latestBalance),
  upsertCashBalance: vi.fn(),
  deleteCashBalance: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// 重型子组件 stub（同 dashboard-page.test.ts）
vi.mock('@/modules/overview/components/NavTrendChart.vue', () => ({
  default: { name: 'NavTrendChart', template: '<div data-testid="nav-chart" />' },
}));
vi.mock('@/modules/overview/components/XirrTrendChart.vue', () => ({
  default: { name: 'XirrTrendChart', template: '<div data-testid="xirr-chart" />' },
}));
vi.mock('@/modules/overview/components/TotalAssetTrendChart.vue', () => ({
  default: {
    name: 'TotalAssetTrendChart',
    template: '<div data-testid="total-asset-chart" />',
  },
}));
vi.mock('@/modules/overview/components/FreshnessBanner.vue', () => ({
  default: { name: 'FreshnessBanner', template: '<div data-testid="freshness-banner" />' },
}));
vi.mock('@/modules/holdings/components/PriceFreshnessBadge.vue', () => ({
  default: { name: 'PriceFreshnessBadge', template: '<div data-testid="price-freshness-badge" />' },
}));
vi.mock('@/modules/cashflow/components/CashflowForm.vue', () => ({
  default: { name: 'CashflowForm', template: '<div data-testid="cashflow-form" />' },
}));
vi.mock('@/modules/security-trade/components/SecurityTradeForm.vue', () => ({
  default: { name: 'SecurityTradeForm', template: '<div data-testid="security-trade-form" />' },
}));
vi.mock('@/components/date/DateRangeQuickPicker.vue', () => ({
  default: { name: 'DateRangeQuickPicker', template: '<div data-testid="date-range-picker" />' },
}));

const PORTFOLIO: Portfolio = {
  id: 'p1',
  userId: 'u1',
  name: '主组合',
  description: null,
  baseDate: '2024-01-01',
  currency: 'CNY',
  archivedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const FULL_OVERVIEW: OverviewResponse = {
  totalAsset: '205000.00',
  cumulativeNav: '1.123456',
  yearNav: '1.050000',
  xirr: '0.1523',
  netInvested: '180000.00',
  totalReturnRate: '0.12345678',
  yearReturnRate: '0.05000000',
  latestDate: '2026-06-30',
  latestSource: 'DERIVED',
  freshness: {
    staleDays: 3,
    isStale: false,
    latestPriceAsOf: '2026-06-30',
    latestPriceLagDays: 0,
    latestCashAsOf: null,
    latestCashLagDays: null,
    reasons: [],
  },
  holdingsSummary: {
    totalMarketValue: '125000.00',
    totalCost: '100000.00',
    totalProfit: '25000.00',
    securityCount: 3,
  },
  recentTransactions: [],
};

function makeSummary(p: Partial<PortfolioSummary>): PortfolioSummary {
  return {
    id: 'p1',
    name: '主组合',
    totalAsset: '205000.00',
    holdingsCount: 3,
    lastUpdatedAt: '2026-06-30',
    baseDate: '2024-01-01',
    currency: 'CNY',
    createdAt: '2024-01-01T00:00:00Z',
    cumulativeNav: '1.123456',
    yearReturnRate: '0.05000000',
    cumulativeReturnRate: '0.12345678',
    xirr: '0.15230000',
    netInvested: '180000.00',
    floatingProfit: '25000.00',
    ...p,
  };
}

const BASE_PREF = {
  id: 'pref-1',
  userId: 'u1',
  defaultPortfolioId: 'p1',
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  showLiquidated: false,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

/** jsdom 缺失的浏览器 API 兜底 */
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
}

let pinia: Pinia;
let queryClient: QueryClient;
let router: Router;

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

async function mountPage(): Promise<VueWrapper> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'dashboard', component: DashboardPage },
      { path: '/cashflows', name: 'cashflows', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(DashboardPage, {
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

/** 组合表现对比某一行（按组合名） */
function summaryRow(
  wrapper: VueWrapper,
  name: string,
): DOMWrapper<Element> | undefined {
  const rows = wrapper.findAll('[class*="bg-muted/40"]');
  return rows.find((r) => r.text().includes(name));
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  fixtures.portfolios = [PORTFOLIO];
  fixtures.overview = FULL_OVERVIEW;
  fixtures.summary = [makeSummary({})];
  fixtures.transactions = { items: [], total: 0, page: 1, pageSize: 5 };
  fixtures.navSeries = [];
  fixtures.xirrSeries = [];
  fixtures.latestNav = { date: '2026-06-30', cumulativeNav: 1.123456, yearNav: 1.05, shares: 1000 };
  fixtures.latestXirr = { date: '2026-06-30', xirrValue: 0.1523 };
  fixtures.latestBalance = {
    id: 'cb-1',
    portfolioId: 'p1',
    amount: '80000.00',
    asOf: '2026-06-01',
    note: null,
    createdAt: '2026-06-01T00:00:00Z',
  };
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const portfolioStore = usePortfolioStore();
  portfolioStore.setPortfolios([PORTFOLIO]);
  portfolioStore.setCurrentPortfolio('p1');
  usePreferenceStore().setPreferences({ ...BASE_PREF } as never);
});

describe('DashboardPage 概览页对齐（§4.2）', () => {
  // ===== A7 关键：失败不伪装空态 =====
  describe('overview 请求失败不伪装成空态（A7 关键）', () => {
    it('overview 失败 → 引导卡不渲染，四宫格仍渲染', async () => {
      vi.mocked(getOverview).mockRejectedValueOnce(new Error('boom'));
      const wrapper = await mountPage();

      // 不得出现三步引导卡
      expect(wrapper.text()).not.toContain('按下面三步录入');
      // 四宫格仍正常渲染（图表 stub 以 data-testid 定位；CardTitle 文本真实）
      expect(wrapper.find('[data-testid="nav-chart"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="xirr-chart"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('近期出入金');
      expect(wrapper.text()).toContain('组合表现对比');

      wrapper.unmount();
    });

    it('overview 成功但无数据（data=null）→ 引导卡渲染、四宫格不渲染', async () => {
      // 【基线对照】空数据（非失败）才渲染引导卡：getOverview 返回 null
      fixtures.overview = null;
      const wrapper = await mountPage();

      expect(wrapper.text()).toContain('按下面三步录入');
      expect(wrapper.find('[data-testid="nav-chart"]').exists()).toBe(false);

      wrapper.unmount();
    });
  });

  // ===== 组合表现对比：NaN 防护 + 涨跌色 =====
  describe('组合表现对比（Q-4 甲）', () => {
    it('字符串比率不产生 NaN%（后端返回 8 位小数字符串）', async () => {
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合');
      expect(row).toBeDefined();
      expect(row!.text()).toContain('12.35%');
      expect(row!.text()).not.toContain('NaN');
      expect(row!.text()).toContain('XIRR 15.23%');

      wrapper.unmount();
    });

    it('null 比率与 null XIRR → 不渲染 NaN%（NaN 防护）', async () => {
      fixtures.summary = [
        makeSummary({ cumulativeReturnRate: null, xirr: null }),
      ];
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合');
      expect(row!.text()).not.toContain('NaN');
      expect(row!.text()).not.toContain('XIRR');

      wrapper.unmount();
    });

    it('正收益率 → text-up（正红）', async () => {
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合')!;
      expect(row.find('span.text-up').exists()).toBe(true);
      expect(row.find('span.text-down').exists()).toBe(false);

      wrapper.unmount();
    });

    it('【关键】负收益率 → text-down（旧 x>=0 分支未覆盖负值）', async () => {
      fixtures.summary = [
        makeSummary({ cumulativeReturnRate: '-0.05', xirr: null }),
      ];
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合')!;
      const rateSpan = row
        .findAll('span')
        .find((s) => s.text().includes('-5.00%'));
      expect(rateSpan).toBeDefined();
      expect(rateSpan!.classes()).toContain('text-down');
      expect(rateSpan!.classes()).not.toContain('text-up');

      wrapper.unmount();
    });

    it('零收益率 → 归入 text-up（>= 0 边界）', async () => {
      fixtures.summary = [makeSummary({ cumulativeReturnRate: '0', xirr: null })];
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合')!;
      const rateSpan = row
        .findAll('span')
        .find((s) => s.text().includes('0.00%'));
      expect(rateSpan).toBeDefined();
      expect(rateSpan!.classes()).toContain('text-up');

      wrapper.unmount();
    });

    it('极小负值（-0.00000001 字符串）→ 仍判负 → text-down（不被误判为 0）', async () => {
      fixtures.summary = [
        makeSummary({ cumulativeReturnRate: '-0.00000001', xirr: null }),
      ];
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合')!;
      const rateSpan = row
        .findAll('span')
        .find((s) => s.text().includes('%'));
      expect(rateSpan).toBeDefined();
      expect(rateSpan!.classes()).toContain('text-down');
      expect(rateSpan!.classes()).not.toContain('text-up');

      wrapper.unmount();
    });

    it('xirrDecimals=4 → 两列均显示 4 位小数', async () => {
      usePreferenceStore().setPreferences({
        ...(BASE_PREF as object),
        xirrDecimals: 4,
      } as never);
      const wrapper = await mountPage();

      const row = summaryRow(wrapper, '主组合')!;
      expect(row.text()).toContain('12.3457%');
      expect(row.text()).toContain('XIRR 15.2300%');

      wrapper.unmount();
    });
  });
});
