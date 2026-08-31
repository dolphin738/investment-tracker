/**
 * modules/overview/__tests__/dashboard-page-dialogs.test.ts — 概览页录入弹窗入口
 *
 * 覆盖（REP-007 · 前端 P0 部分覆盖补全 · FE-OVW-06/07）：
 * 1. 点击页头「录入出入金」按钮 → 出入金弹窗打开且 CashflowForm 挂载（入口挂载链路）。
 * 2. 点击页头「录入买卖」按钮 → 买卖弹窗打开且 SecurityTradeForm 挂载（入口挂载链路）。
 *
 * 这两个弹窗此前在 dashboard-page.test.ts 里仅以 stub 形式存在（未验证「点击 →
 * 弹窗打开 → 表单挂载」的真实链路）。本测试补齐该交互链路。
 *
 * reka-ui Dialog 经 Portal 渲染到 body，故弹窗内表单须在 document 上定位
 * （与 settings-danger-zone / snapshot-list-row-actions 一致，不可加 stubs.teleport）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import DashboardPage from '../pages/DashboardPage.vue';
import { getOverview } from '@/api/overview.api';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type { OverviewResponse, PortfolioSummary, TransactionResponse } from '@/api/types';
import type { Portfolio } from '@/lib/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

const fixtures = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  overview: null as OverviewResponse | null,
  summary: [] as PortfolioSummary[],
  transactions: {
    items: [] as TransactionResponse[],
    total: 0,
    page: 1,
    pageSize: 5,
  },
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
  getNavSeries: vi.fn(async () => []),
  getXirrSeries: vi.fn(async () => []),
  getLatestNav: vi.fn(async () => null),
  getLatestXirr: vi.fn(async () => null),
}));
vi.mock('@/api/cash-balance.api', () => ({
  listCashBalances: vi.fn(),
  getLatestCashBalance: vi.fn(async () => null),
  upsertCashBalance: vi.fn(),
  deleteCashBalance: vi.fn(),
}));
vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// 重型 / 弹窗内子组件 stub
vi.mock('@/components/charts/NavTrendChart.vue', () => ({
  default: { name: 'NavTrendChart', template: '<div data-testid="nav-chart" />' },
}));
vi.mock('@/components/charts/XirrTrendChart.vue', () => ({
  default: { name: 'XirrTrendChart', template: '<div data-testid="xirr-chart" />' },
}));
vi.mock('@/modules/overview/components/TotalAssetTrendChart.vue', () => ({
  default: { name: 'TotalAssetTrendChart', template: '<div data-testid="total-asset-chart" />' },
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

async function mountPage() {
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
    attachTo: document.body,
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  fixtures.portfolios = [PORTFOLIO];
  fixtures.overview = FULL_OVERVIEW;
  fixtures.summary = [];
  fixtures.transactions = { items: [], total: 0, page: 1, pageSize: 5 };
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const portfolioStore = usePortfolioStore();
  portfolioStore.setPortfolios([PORTFOLIO]);
  portfolioStore.setCurrentPortfolio('p1');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DashboardPage 录入弹窗入口（FE-OVW-06/07）', () => {
  it('FE-OVW-06 点击「录入出入金」→ 弹窗打开且 CashflowForm 挂载', async () => {
    const wrapper = await mountPage();

    const btn = wrapper
      .findAll('button')
      .find((b) => (b.text() ?? '').includes('录入出入金'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await settle();

    // reka-ui Dialog Portal 到 body：表单须从 document 定位
    expect(document.querySelector('[data-testid="cashflow-form"]')).not.toBeNull();
  });

  it('FE-OVW-07 点击「录入买卖」→ 弹窗打开且 SecurityTradeForm 挂载', async () => {
    const wrapper = await mountPage();

    const btn = wrapper
      .findAll('button')
      .find((b) => (b.text() ?? '').includes('录入买卖'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await settle();

    expect(document.querySelector('[data-testid="security-trade-form"]')).not.toBeNull();
  });
});
