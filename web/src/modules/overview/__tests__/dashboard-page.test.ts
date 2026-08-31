/**
 * modules/overview/__tests__/dashboard-page.test.ts — 概览页组件测试
 *
 * 覆盖（B4 批次验收：渲染 / 空态 / 无数据引导）：
 * 1. 无组合空态：组合列表为空 → 引导创建第一个组合，且不发起概览查询
 * 2. 未选组合：有组合但未选中 →「请先在顶部选择一个投资组合」
 * 3. 有数据渲染：8 指标卡按「资产构成 / 收益表现」两组出齐、金额千分位、
 *    近期出入金 5 笔（存入/取出与金额符号）、组合表现对比（收益率 + XIRR）
 * 4. 有组合无数据（DASH-P0-06）：三步引导卡渲染，四宫格不渲染
 *
 * 数据层 mock：overview / portfolio / transaction / query / cash-balance API
 * 与图表等重型子组件全部 mock（图表挂载依赖 canvas，不属本测试关注点）；
 * Pinia store（portfolio/preference）与 useUrlState 真实。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import DashboardPage from '../pages/DashboardPage.vue';
import { getOverview } from '@/api/overview.api';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type {
  OverviewResponse,
  PortfolioSummary,
  TransactionResponse,
} from '@/api/types';
import type { Portfolio } from '@/lib/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层 API（可变夹具：各用例按需覆写）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// mock：重型子组件 stub（ECharts / 弹窗表单 / 轮询徽标 / 日期范围选择器）
// ---------------------------------------------------------------------------

vi.mock('@/components/charts/NavTrendChart.vue', () => ({
  default: { name: 'NavTrendChart', template: '<div data-testid="nav-chart" />' },
}));
vi.mock('@/components/charts/XirrTrendChart.vue', () => ({
  default: {
    name: 'XirrTrendChart',
    template: '<div data-testid="xirr-chart" />',
  },
}));
vi.mock('@/modules/overview/components/TotalAssetTrendChart.vue', () => ({
  default: {
    name: 'TotalAssetTrendChart',
    template: '<div data-testid="total-asset-chart" />',
  },
}));
vi.mock('@/modules/overview/components/FreshnessBanner.vue', () => ({
  default: {
    name: 'FreshnessBanner',
    template: '<div data-testid="freshness-banner" />',
  },
}));
vi.mock('@/modules/holdings/components/PriceFreshnessBadge.vue', () => ({
  default: {
    name: 'PriceFreshnessBadge',
    template: '<div data-testid="price-freshness-badge" />',
  },
}));
vi.mock('@/modules/cashflow/components/CashflowForm.vue', () => ({
  default: {
    name: 'CashflowForm',
    template: '<div data-testid="cashflow-form" />',
  },
}));
vi.mock('@/components/date/DateRangeQuickPicker.vue', () => ({
  default: {
    name: 'DateRangeQuickPicker',
    template: '<div data-testid="date-range-picker" />',
  },
}));

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

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

/** 完整概览数据（字符串金额 / 比率契约，见 api/types OverviewResponse） */
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

const SUMMARY_ROW: PortfolioSummary = {
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
};

function makeTx(p: Partial<TransactionResponse>): TransactionResponse {
  return {
    id: 'tx-1',
    portfolioId: 'p1',
    date: '2026-06-10',
    type: 'BUY',
    amount: '1000.00',
    note: null,
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
    ...p,
  };
}

/** jsdom 缺失的浏览器 API 兜底（reka-ui Tabs / Dialog 需要） */

let pinia: Pinia;
let queryClient: QueryClient;
let router: Router;

/** 等待 vue-query 请求落地 + useUrlState 微任务链全部完成 */
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
  // 重置 URL（useUrlState 读写 query，避免用例间污染）
  window.history.replaceState(null, '', '/');
  // 默认夹具：单组合 + 完整概览（无组合 / 无数据用例按需覆写）
  fixtures.portfolios = [PORTFOLIO];
  fixtures.overview = FULL_OVERVIEW;
  fixtures.summary = [SUMMARY_ROW];
  fixtures.transactions = {
    items: [
      makeTx({ id: 'tx-1', date: '2026-06-10', type: 'BUY', amount: '1000.00', note: '工资入金' }),
      makeTx({ id: 'tx-2', date: '2026-06-12', type: 'SELL', amount: '500.00', note: null }),
    ],
    total: 2,
    page: 1,
    pageSize: 5,
  };
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
});

// ---------------------------------------------------------------------------

describe('DashboardPage — 概览页', () => {
  it('无组合空态：引导创建第一个组合，且不发起概览查询', async () => {
    fixtures.portfolios = [];
    const portfolioStore = usePortfolioStore();
    portfolioStore.setPortfolios([]);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('欢迎，先创建您的第一个投资组合');
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('未选组合：提示先在顶部选择组合', async () => {
    const portfolioStore = usePortfolioStore();
    portfolioStore.clearCurrent();
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('请先在顶部选择一个投资组合');
  });

  it('有数据渲染：8 指标卡两组出齐、金额千分位、近期出入金与组合表现对比', async () => {
    const wrapper = await mountPage();
    const text = wrapper.text();

    // 分组与区块标题
    expect(text).toContain('关键指标');
    expect(text).toContain('资产构成');
    expect(text).toContain('收益表现');
    expect(text).toContain('趋势分析');

    // 8 卡标题（资产构成 4 + 收益表现 4）
    for (const title of [
      '当前总资产',
      '持仓市值',
      '现金余额',
      '净投入',
      '累计收益率',
      '当年收益率',
      '年化 XIRR',
      '累计净值',
    ]) {
      expect(text).toContain(title);
    }

    // 金额千分位（偏好 amountThousands 默认开）与数据截止描述
    expect(text).toContain('¥205,000.00');
    expect(text).toContain('截至 2026-06-30');

    // 近期出入金：日期 + 类型中文 + 带符号金额
    expect(text).toContain('近期出入金');
    expect(text).toContain('06-10');
    expect(text).toContain('存入');
    expect(text).toContain('+¥1,000.00');
    expect(text).toContain('取出');
    expect(text).toContain('-¥500.00');

    // 组合表现对比：组合名 + 累计收益率 + XIRR（xirrDecimals 默认 2 位）
    expect(text).toContain('组合表现对比');
    expect(text).toContain('主组合');
    expect(text).toContain('12.35%');
    expect(text).toContain('XIRR');
    expect(text).toContain('15.23%');

    // hero 图与四宫格图表 stub 挂载
    expect(wrapper.find('[data-testid="total-asset-chart"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="nav-chart"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="xirr-chart"]').exists()).toBe(true);
  });

  it('有组合无数据：渲染三步引导卡（DASH-P0-06），四宫格不渲染', async () => {
    fixtures.overview = null;
    const wrapper = await mountPage();
    const text = wrapper.text();

    expect(text).toContain('开始记录你的投资');
    expect(text).toContain('创建组合');
    expect(text).toContain('录入首笔存入');
    expect(text).toContain('录入证券买卖 / 现价');

    // 四宫格整块不渲染（图表 stub 与近期出入金卡片均不出现）
    expect(wrapper.find('[data-testid="nav-chart"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="xirr-chart"]').exists()).toBe(false);
    expect(text).not.toContain('近期出入金');
  });
});
