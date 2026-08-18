/**
 * modules/holdings/__tests__/holdings-page-alignment.test.ts — 持仓页对齐 React 验收（§9.2）
 *
 * 平移自 React 版 web/src/pages/__tests__/holdings-page.test.tsx 核心断言：
 * - A1 Tabs 互斥：切「买卖明细」后持仓表与汇总卡卸载、买卖区挂载，切回恢复
 * - A2 11 列 + 红涨绿跌（盈利 text-up + 带 + 号 / 亏损 text-down / 持平 pnl=0 → text-up）
 * - A3 汇总 5 卡 + lg:grid-cols-5 + 总盈亏率数值 + 负盈亏率 text-down
 * - A4 市值降序（乱序输入 → 甲5w→乙3w→丙2w）+ 不污染 vue-query 缓存源数组
 * - A5 占比进度条（aria-valuenow/文本）+ totalMarketValue=0 NaN 防护 + aggregate 缺失边界
 * - xirrDecimals 联动（盈亏率/总盈亏率小数位跟随、占比固定 2 位）
 * - scenario→side 传导（§9.1 修复钉死）：URL scenario=BUY/SELL → 买卖明细 query.side
 *
 * 数据层 mock：portfolio/holding API + 重型子组件（买卖表单/列表/分红）替身；
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
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import type {
  HoldingResponse,
  HoldingsAggregate,
} from '@/api/types';
import type { Portfolio } from '@/lib/types';

// reka-ui Select 原生替身（HoldingsToolbar 的下拉；jsdom 挂载稳健）
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

// 重型子组件替身：只保留可定位标记；买卖列表 stub 渲染 query.side 供 scenario→side 断言
// 注意：HoldingsPage 用别名 import（@/modules/...），vi.mock 必须用同一模块 ID
vi.mock('@/modules/security-trade/components/SecurityTradeList.vue', () => ({
  default: defineComponent({
    name: 'SecurityTradeListStub',
    props: { query: { type: Object, default: () => ({}) } },
    setup(props) {
      return () =>
        h(
          'div',
          { 'data-testid': 'trade-list' },
          `side=${(props.query as { side?: string })?.side ?? ''}`,
        );
    },
  }),
}));
vi.mock('@/modules/security-trade/components/SecurityTradeForm.vue', () => ({
  default: defineComponent({
    name: 'SecurityTradeFormStub',
    setup() {
      return () => h('div', { 'data-testid': 'trade-form' }, '买卖表单');
    },
  }),
}));
vi.mock('@/modules/security-income/components/DividendList.vue', () => ({
  default: defineComponent({
    name: 'DividendListStub',
    setup() {
      return () => h('div', { 'data-testid': 'dividend-list' }, '分红列表');
    },
  }),
}));

// ---------------------------------------------------------------------------
// 数据层 mock（可变夹具）
// ---------------------------------------------------------------------------

const PORTFOLIO: Portfolio = {
  id: 'pf-1',
  userId: 'u1',
  name: '测试组合',
  description: null,
  baseDate: '2024-01-01',
  currency: 'CNY',
  archivedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

/**
 * 三条持仓，故意不按市值降序（乙 3w → 甲 5w → 丙 2w），
 * 用于验证前端排序确实生效；市值 50000/30000/20000，总市值 100000 → 占比 50/30/20。
 */
const ITEMS: HoldingResponse[] = [
  {
    securityId: 's-b',
    securityCode: '000002',
    securityName: '乙基金',
    securityType: 'ON_EXCHANGE_FUND',
    quantity: 200,
    avgCost: 100,
    costTotal: 20000,
    marketPrice: 150,
    priceAsOf: '2026-06-15',
    marketValue: 30000,
    pnl: 10000,
    pnlRate: 0.5,
    flag: 'EXACT',
  },
  {
    securityId: 's-a',
    securityCode: '600000',
    securityName: '甲股票',
    securityType: 'STOCK',
    quantity: 1000,
    avgCost: 51.5,
    costTotal: 51500,
    marketPrice: 50,
    priceAsOf: '2026-06-15',
    marketValue: 50000,
    pnl: -1500,
    pnlRate: -0.029126,
    flag: 'EXACT',
  },
  {
    securityId: 's-c',
    securityCode: '019547',
    securityName: '丙债券',
    securityType: 'BOND',
    quantity: 200,
    avgCost: 100,
    costTotal: 20000,
    marketPrice: 100,
    priceAsOf: null,
    marketValue: 20000,
    pnl: 0,
    pnlRate: 0,
    flag: 'COST_BASED',
  },
];

const AGGREGATE: HoldingsAggregate = {
  totalMarketValue: 100000,
  totalCost: 91500,
  totalProfit: 8500,
  totalProfitRate: 0.0929,
  securityCount: 3,
};

const BASE_PREF = {
  id: 'pref-1',
  userId: 'u1',
  defaultPortfolioId: 'pf-1',
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

const fixtures = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  securities: [] as unknown[],
  holdings: {
    items: [] as HoldingResponse[],
    aggregate: undefined as HoldingsAggregate | undefined,
  },
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

vi.mock('@/modules/cashflow/composables/use-transactions', () => ({
  useTransactions: () => ({ data: ref(undefined), isLoading: ref(false) }),
}));

vi.mock('@/modules/holdings/composables/use-price-sync-status', () => ({
  usePriceSyncStatus: () => ({ data: ref(null) }),
}));

/** PRD §5.2.3 锁定的 11 列表头顺序 */
const EXPECTED_HEADERS = [
  '标的', '代码', '类型', '数量', '成本价', '现价',
  '成本额', '市值', '浮动盈亏', '盈亏率', '占比',
];

let pinia: Pinia;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

async function mountPage(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(HoldingsPage, {
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

/** 按文本点 Tab（reka-ui TabsTrigger 由 onMousedown 激活；role="tab" 精确定位） */
async function clickTab(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const btn = wrapper
    .findAll('[role="tab"]')
    .find((b) => b.text().trim() === label);
  if (!btn) throw new Error(`未找到 Tab「${label}」`);
  await btn.trigger('mousedown');
  await settle();
  // TabsContent 经 Presence 挂载（jsdom 无过渡动画，但需要 rAF 帧）
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flushPromises();
}

/** 持仓表数据行 */
function bodyRows(wrapper: ReturnType<typeof mount>): ReturnType<typeof wrapper.findAll> {
  return wrapper.findAll('tbody tr');
}

/** 某行第 n 列单元格 */
function cellAt(
  wrapper: ReturnType<typeof mount>,
  rowIdx: number,
  colIdx: number,
): ReturnType<typeof wrapper.find> {
  const cells = bodyRows(wrapper)[rowIdx]?.findAll('td');
  if (!cells) throw new Error(`第 ${rowIdx} 行不存在`);
  const cell = cells[colIdx];
  if (!cell) throw new Error(`第 ${colIdx} 列不存在（共 ${cells.length} 列）`);
  return cell;
}

const COL = {
  NAME: 0, CODE: 1, TYPE: 2, QTY: 3, AVG_COST: 4, PRICE: 5,
  COST_TOTAL: 6, MARKET_VALUE: 7, PNL: 8, PNL_RATE: 9, WEIGHT: 10,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  fixtures.portfolios = [PORTFOLIO];
  fixtures.securities = [];
  fixtures.holdings = { items: [...ITEMS], aggregate: { ...AGGREGATE } };
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const portfolioStore = usePortfolioStore();
  portfolioStore.setPortfolios([PORTFOLIO]);
  portfolioStore.setCurrentPortfolio('pf-1');
  usePreferenceStore().setPreferences({ ...BASE_PREF } as never);
});

describe('HoldingsPage 阶段 A 对齐（§9.2）', () => {
  // ===== A1：Tabs 互斥 =====
  describe('A1 Tabs 互斥（TabsContent 卸载）', () => {
    it('默认持仓 Tab：持仓表可见、买卖明细不在 DOM', async () => {
      const wrapper = await mountPage();

      expect(wrapper.text()).toContain('甲股票');
      expect(wrapper.find('[data-testid="trade-list"]').exists()).toBe(false);

      wrapper.unmount();
    });

    it('切「买卖明细」：买卖列表出现，持仓表与汇总卡同时卸载（互斥）', async () => {
      const wrapper = await mountPage();

      await clickTab(wrapper, '买卖明细');

      expect(wrapper.find('[data-testid="trade-list"]').exists()).toBe(true);
      expect(wrapper.text()).not.toContain('甲股票');
      expect(wrapper.text()).not.toContain('总盈亏率');
      expect(wrapper.findAll('tbody tr')).toHaveLength(0);

      wrapper.unmount();
    });

    it('切回「持仓」：持仓区恢复、买卖区卸载', async () => {
      const wrapper = await mountPage();

      await clickTab(wrapper, '买卖明细');
      expect(wrapper.find('[data-testid="trade-list"]').exists()).toBe(true);

      await clickTab(wrapper, '持仓');
      expect(wrapper.text()).toContain('甲股票');
      expect(wrapper.find('[data-testid="trade-list"]').exists()).toBe(false);

      wrapper.unmount();
    });
  });

  // ===== A2：11 列 + 着色 =====
  describe('A2 持仓列表 11 列与红涨绿跌', () => {
    it('表头恰为 11 列且顺序与 PRD §5.2.3 一致', async () => {
      const wrapper = await mountPage();

      const headers = wrapper.findAll('thead th').map((h) => h.text().trim());
      expect(headers).toEqual(EXPECTED_HEADERS);

      wrapper.unmount();
    });

    it('盈利行：浮动盈亏与盈亏率用 text-up，金额带 + 号', async () => {
      const wrapper = await mountPage();

      // 排序后第 2 行为乙基金（市值 30000，pnl=+10000）
      const row = bodyRows(wrapper)[1];
      expect(row.find('td').text()).toContain('乙基金');

      const pnl = cellAt(wrapper, 1, COL.PNL);
      expect(pnl.classes()).toContain('text-up');
      expect(pnl.classes()).not.toContain('text-down');
      expect(pnl.text()).toBe('+¥10,000.00');

      const rate = cellAt(wrapper, 1, COL.PNL_RATE);
      expect(rate.classes()).toContain('text-up');
      expect(rate.text()).toBe('50.00%');

      wrapper.unmount();
    });

    it('亏损行：浮动盈亏与盈亏率用 text-down，带负号无 + 号', async () => {
      const wrapper = await mountPage();

      const row = bodyRows(wrapper)[0]; // 甲股票 pnl=-1500
      expect(row.find('td').text()).toContain('甲股票');

      const pnl = cellAt(wrapper, 0, COL.PNL);
      expect(pnl.classes()).toContain('text-down');
      expect(pnl.classes()).not.toContain('text-up');
      expect(pnl.text()).toBe('¥-1,500.00');

      const rate = cellAt(wrapper, 0, COL.PNL_RATE);
      expect(rate.classes()).toContain('text-down');
      expect(rate.text()).toBe('-2.91%');

      wrapper.unmount();
    });

    it('持平行（pnl=0）按涨色处理（>=0 → text-up）', async () => {
      const wrapper = await mountPage();

      const row = bodyRows(wrapper)[2]; // 丙债券 pnl=0
      expect(row.find('td').text()).toContain('丙债券');

      const pnl = cellAt(wrapper, 2, COL.PNL);
      expect(pnl.classes()).toContain('text-up');
      expect(pnl.text()).toBe('+¥0.00');
      expect(cellAt(wrapper, 2, COL.PNL_RATE).classes()).toContain('text-up');

      wrapper.unmount();
    });
  });

  // ===== A3：汇总 5 卡 =====
  describe('A3 汇总区总盈亏率', () => {
    it('5 项汇总齐备且总盈亏率数值正确', async () => {
      const wrapper = await mountPage();

      for (const label of ['总市值', '总成本', '浮盈', '总盈亏率', '标的数']) {
        expect(wrapper.text()).toContain(label);
      }
      expect(wrapper.text()).toContain('9.29%');

      wrapper.unmount();
    });

    it('栅格 lg:grid-cols-5', async () => {
      const wrapper = await mountPage();

      const grid = wrapper
        .findAll('div.grid')
        .find((g) => g.classes().includes('lg:grid-cols-5'));
      expect(grid).toBeDefined();

      wrapper.unmount();
    });

    it('总盈亏率为负时用 text-down', async () => {
      fixtures.holdings = {
        items: [...ITEMS],
        aggregate: { ...AGGREGATE, totalProfitRate: -0.1234 },
      };
      const wrapper = await mountPage();

      const el = wrapper.findAll('p').find((p) => p.text() === '-12.34%');
      expect(el).toBeDefined();
      expect(el!.classes()).toContain('text-down');

      wrapper.unmount();
    });
  });

  // ===== A4：排序 =====
  describe('A4 默认按市值降序', () => {
    it('渲染顺序为 甲(5w) → 乙(3w) → 丙(2w)，而非接口返回顺序', async () => {
      const wrapper = await mountPage();

      const names = bodyRows(wrapper).map((r) => r.find('td')!.text());
      expect(names[0]).toContain('甲股票');
      expect(names[1]).toContain('乙基金');
      expect(names[2]).toContain('丙债券');

      wrapper.unmount();
    });

    it('不污染 vue-query 缓存：源 items 数组顺序保持不变', async () => {
      const source = [...ITEMS]; // 乙/甲/丙
      fixtures.holdings = { items: source, aggregate: { ...AGGREGATE } };
      const wrapper = await mountPage();

      expect(bodyRows(wrapper)[0].find('td')!.text()).toContain('甲股票');
      expect(source.map((i) => i.securityId)).toEqual(['s-b', 's-a', 's-c']);

      wrapper.unmount();
    });
  });

  // ===== A5：占比进度条 =====
  describe('A5 占比进度条', () => {
    it('每行一个 progressbar，aria-valuenow 与百分比文本一致', async () => {
      const wrapper = await mountPage();

      const rows = bodyRows(wrapper);
      expect(rows).toHaveLength(3);
      const expected = [50, 30, 20]; // 甲/乙/丙

      rows.forEach((row, idx) => {
        const weightCell = row.findAll('td')[COL.WEIGHT];
        const bar = weightCell.find('[role="progressbar"]');
        expect(bar.exists()).toBe(true);
        expect(weightCell.text()).toContain(`${expected[idx].toFixed(2)}%`);
        expect(Number(bar.attributes('aria-valuenow'))).toBeCloseTo(
          expected[idx],
          6,
        );
      });

      wrapper.unmount();
    });

    it('边界：totalMarketValue=0 时 weight 归 0，不产生 NaN', async () => {
      fixtures.holdings = {
        items: [{ ...ITEMS[0], marketValue: 0 }],
        aggregate: { ...AGGREGATE, totalMarketValue: 0 },
      };
      const wrapper = await mountPage();

      const cell = cellAt(wrapper, 0, COL.WEIGHT);
      expect(cell.text()).toContain('0.00%');
      expect(cell.text()).not.toContain('NaN');
      const bar = cell.find('[role="progressbar"]');
      expect(bar.attributes('aria-valuenow')).toBe('0');

      wrapper.unmount();
    });

    it('边界：aggregate 缺失时列表仍渲染，占比归 0 且汇总卡不渲染', async () => {
      fixtures.holdings = { items: [...ITEMS], aggregate: undefined };
      const wrapper = await mountPage();

      expect(wrapper.text()).not.toContain('总盈亏率');
      expect(bodyRows(wrapper)).toHaveLength(3);
      for (let i = 0; i < 3; i += 1) {
        const cell = cellAt(wrapper, i, COL.WEIGHT);
        expect(cell.text()).toContain('0.00%');
        expect(cell.text()).not.toContain('NaN');
      }

      wrapper.unmount();
    });
  });

  // ===== xirrDecimals 联动 =====
  describe('偏好 xirrDecimals 联动（盈亏率 / 总盈亏率）', () => {
    it('xirrDecimals=4 时盈亏率与总盈亏率同步 4 位小数', async () => {
      usePreferenceStore().setPreferences({
        ...(BASE_PREF as object),
        xirrDecimals: 4,
      } as never);
      const wrapper = await mountPage();

      expect(wrapper.text()).toContain('9.2900%');
      expect(cellAt(wrapper, 0, COL.PNL_RATE).text()).toBe('-2.9126%');
      expect(cellAt(wrapper, 1, COL.PNL_RATE).text()).toBe('50.0000%');

      wrapper.unmount();
    });

    it('占比列固定 2 位小数，不随 xirrDecimals 变化', async () => {
      usePreferenceStore().setPreferences({
        ...(BASE_PREF as object),
        xirrDecimals: 4,
      } as never);
      const wrapper = await mountPage();

      expect(cellAt(wrapper, 0, COL.WEIGHT).text()).toContain('50.00%');

      wrapper.unmount();
    });
  });

  // ===== scenario→side 传导（§9.1 钉死） =====
  describe('scenario→side 传导（§9.1）', () => {
    it('URL scenario=BUY → 买卖明细 query.side=BUY_SEC', async () => {
      window.history.replaceState(null, '', '/?scenario=BUY');
      const wrapper = await mountPage();

      await clickTab(wrapper, '买卖明细');

      const list = wrapper.find('[data-testid="trade-list"]');
      expect(list.exists()).toBe(true);
      expect(list.text()).toContain('side=BUY_SEC');

      wrapper.unmount();
    });

    it('URL scenario=SELL → 买卖明细 query.side=SELL_SEC', async () => {
      window.history.replaceState(null, '', '/?scenario=SELL');
      const wrapper = await mountPage();

      await clickTab(wrapper, '买卖明细');

      expect(wrapper.find('[data-testid="trade-list"]').text()).toContain(
        'side=SELL_SEC',
      );

      wrapper.unmount();
    });

    it('URL 无 scenario → 不传 side（undefined）', async () => {
      const wrapper = await mountPage();

      await clickTab(wrapper, '买卖明细');

      expect(wrapper.find('[data-testid="trade-list"]').text()).toContain(
        'side=',
      );
      expect(wrapper.find('[data-testid="trade-list"]').text()).not.toContain(
        'side=BUY_SEC',
      );
      expect(wrapper.find('[data-testid="trade-list"]').text()).not.toContain(
        'side=SELL_SEC',
      );

      wrapper.unmount();
    });
  });
});
