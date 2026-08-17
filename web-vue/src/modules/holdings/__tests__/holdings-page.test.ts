/**
 * modules/holdings/__tests__/holdings-page.test.ts — 持仓页组件测试（@vue/test-utils）
 *
 * 覆盖（B5 批次验收：渲染 / 空态 / 筛选交互）：
 * 1. 持仓表渲染：PRD §5.2.3 全 11 列表头 + 汇总 5 卡 + 前端排序
 *    （正常持仓在前、市值降序；已清仓垫底）+ 已清仓/成本估值徽标
 * 2. 无结果空态：items=[] 且无标的 → EmptyState「暂无持仓数据」引导文案
 * 3. 无组合空态：组合列表为空 → EmptyState「暂无投资组合」
 * 4. 筛选联动：as-of 日期变更 → listHoldings 携带新 date 重新查询 + URL 写入 date
 *
 * 数据层 mock：portfolio/holding API 与无关 composable 全部 mock，
 * Pinia store（portfolio/preference）真实，useUrlState 真实（jsdom history 可用）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import HoldingsPage from '../pages/HoldingsPage.vue';
import { listHoldings } from '@/api/holding.api';
import { listPortfolios } from '@/api/portfolio.api';
import { todayInAppTzIso } from '@/lib/constants';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type { HoldingResponse, HoldingsAggregate, Security } from '@/api/types';
import type { Portfolio } from '@/lib/types';

// reka-ui Select 的原生替身（页面测试不与其交互，仅为 jsdom 挂载稳健）
vi.mock('@/components/ui/select', async () => {
  await import('vue');
  const Select = defineComponent({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () =>
        h(
          'select',
          {
            value: props.modelValue ?? '',
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          [h('option', { key: '__ph', value: '' }, ''), slots.default?.()],
        );
    },
  });
  const SelectItem = defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      return () => h('option', { value: props.value }, slots.default?.());
    },
  });
  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
  const renderNothing = defineComponent({
    setup() {
      return () => null;
    },
  });
  return {
    Select,
    SelectItem,
    SelectTrigger: renderNothing,
    SelectValue: renderNothing,
    SelectContent: passthrough,
    SelectGroup: passthrough,
    SelectLabel: passthrough,
    SelectSeparator: renderNothing,
    SelectScrollUpButton: renderNothing,
    SelectScrollDownButton: renderNothing,
  };
});

// ---------------------------------------------------------------------------
// 数据层 mock（可变夹具：各用例按需覆写）
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

const SECURITIES: Security[] = [
  {
    id: 's-a',
    portfolioId: 'p1',
    name: '甲股票',
    code: '600000',
    type: 'STOCK',
    note: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

const AGGREGATE: HoldingsAggregate = {
  totalMarketValue: 20500,
  totalCost: 18500,
  totalProfit: 2000,
  totalProfitRate: 0.1081,
  securityCount: 3,
};

function makeHolding(p: Partial<HoldingResponse>): HoldingResponse {
  return {
    securityId: 's-a',
    securityCode: '600000',
    securityName: '甲股票',
    securityType: 'STOCK',
    quantity: 100,
    avgCost: 10,
    costTotal: 1000,
    marketPrice: 12.5,
    priceAsOf: '2026-06-01',
    marketValue: 1250,
    pnl: 250,
    pnlRate: 0.25,
    flag: 'EXACT',
    ...p,
  };
}

/** 乱序返回：已清仓在最前、市值低的中插，验证前端排序兜底 */
const HOLDING_ITEMS: HoldingResponse[] = [
  makeHolding({
    securityId: 's-c',
    securityName: '丙债券',
    securityCode: '019547',
    securityType: 'BOND',
    quantity: 0,
    avgCost: 100,
    costTotal: 0,
    marketPrice: 100,
    marketValue: 0,
    pnl: 0,
    pnlRate: 0,
    flag: 'COST_BASED',
  }),
  makeHolding({
    securityId: 's-b',
    securityName: '乙基金',
    securityCode: '000002',
    securityType: 'ON_EXCHANGE_FUND',
    quantity: 1000,
    avgCost: 0.8,
    costTotal: 800,
    marketPrice: 0.8,
    marketValue: 800,
    pnl: 0,
    pnlRate: 0,
  }),
  makeHolding({
    securityId: 's-a',
    quantity: 1000,
    avgCost: 12,
    costTotal: 12000,
    marketPrice: 12.5,
    marketValue: 12500,
    pnl: 500,
    pnlRate: 0.0417,
  }),
];

const fixtures = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  securities: [] as Security[],
  holdings: { items: [] as HoldingResponse[], aggregate: undefined as HoldingsAggregate | undefined },
}));

vi.mock('@/api/portfolio.api', () => ({
  listPortfolios: vi.fn(async () => fixtures.portfolios),
}));

vi.mock('@/api/holding.api', () => ({
  listHoldings: vi.fn(async () => fixtures.holdings),
}));

vi.mock('@/composables/use-securities', () => ({
  useSecurities: () => ({
    data: ref(fixtures.securities),
    isLoading: ref(false),
  }),
}));

// 首笔交易查询（minDate 兜底链路）与行情徽标轮询：与页面主链路无关，mock 掉
vi.mock('@/modules/cashflow/composables/use-transactions', () => ({
  useTransactions: () => ({ data: ref(undefined), isLoading: ref(false) }),
}));

vi.mock('@/modules/holdings/composables/use-price-sync-status', () => ({
  usePriceSyncStatus: () => ({ data: ref(null) }),
}));

let pinia: Pinia;
let queryClient: QueryClient;

/** 等待 vue-query 请求落地 + useUrlState 微任务 flush 全部完成 */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

async function mountPage() {
  const wrapper = mount(HoldingsPage, {
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 重置 URL（useUrlState 会把筛选写入 query，避免用例间污染）
  window.history.replaceState(null, '', '/');
  fixtures.portfolios = [PORTFOLIO];
  fixtures.securities = SECURITIES;
  fixtures.holdings = { items: HOLDING_ITEMS, aggregate: AGGREGATE };
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const portfolioStore = usePortfolioStore();
  portfolioStore.setPortfolios([PORTFOLIO]);
  portfolioStore.setCurrentPortfolio('p1');
});

describe('HoldingsPage 持仓页', () => {
  it('渲染 11 列持仓表 + 汇总 5 卡，且按「正常在前市值降序、已清仓垫底」排序', async () => {
    const wrapper = await mountPage();

    // 汇总 5 卡
    const text = wrapper.text();
    expect(text).toContain('总市值');
    expect(text).toContain('¥20,500.00');
    expect(text).toContain('总成本');
    expect(text).toContain('总盈亏率');
    expect(text).toContain('标的数');

    // 表头 11 列
    const headers = wrapper.findAll('thead th');
    expect(headers.map((h) => h.text())).toEqual([
      '标的', '代码', '类型', '数量', '成本价', '现价',
      '成本额', '市值', '浮动盈亏', '盈亏率', '占比',
    ]);

    // 行排序：甲(12500) → 乙(800) → 丙(已清仓 0)
    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r.find('td')!.text());
    expect(names[0]).toContain('甲股票');
    expect(names[1]).toContain('乙基金');
    expect(names[2]).toContain('丙债券');
    // 已清仓 / 成本估值徽标
    expect(rows[2].text()).toContain('已清仓');
    expect(rows[2].text()).toContain('成本估值');
  });

  it('无持仓且无标的 → 空态引导「录入买卖」', async () => {
    fixtures.holdings = { items: [], aggregate: undefined };
    fixtures.securities = [];
    const wrapper = await mountPage();

    const text = wrapper.text();
    expect(text).toContain('暂无持仓数据');
    expect(text).toContain('请先在「录入买卖」中搜索并选择标的，再录入买卖流水');
  });

  it('无组合 → 空态「暂无投资组合」且不发起持仓查询', async () => {
    fixtures.portfolios = [];
    const portfolioStore = usePortfolioStore();
    portfolioStore.setPortfolios([]);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('暂无投资组合');
    expect(wrapper.text()).toContain('请先在账户页「我的组合」创建组合');
    expect(listHoldings).not.toHaveBeenCalled();
    expect(listPortfolios).toHaveBeenCalledTimes(1);
  });

  it('as-of 日期变更 → listHoldings 携带新日期重新查询并写入 URL', async () => {
    const wrapper = await mountPage();
    expect(listHoldings).toHaveBeenCalledTimes(1);

    // 定位 as-of 输入（快捷范围的结束日期同样回显今天，取最后一个匹配即 as-of）
    const today = todayInAppTzIso();
    const asOf = wrapper
      .findAll('input[type="date"]')
      .filter((i) => (i.element as HTMLInputElement).value === today)
      .at(-1);
    expect(asOf).toBeDefined();
    await asOf!.setValue('2025-12-31');
    await settle();

    // 新查询携带新日期（其余维度保持默认）
    expect(listHoldings).toHaveBeenCalledTimes(2);
    expect(listHoldings).toHaveBeenLastCalledWith('p1', {
      date: '2025-12-31',
      includeClosed: false,
      securityId: undefined,
      types: undefined,
    });
    // URL 写入 date（默认值不写、变更值写入）
    expect(window.location.search).toContain('date=2025-12-31');
  });
});
