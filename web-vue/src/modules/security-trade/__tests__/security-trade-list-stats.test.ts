/**
 * modules/security-trade/__tests__/security-trade-list-stats.test.ts
 * — 三统计块 + 列改名（INC-03）
 *
 * 验证点（对齐增量 PRD INC-03 验收）：
 * 1. 列头改名：单价→「成本价」、费用→「费用合计」，并新增「佣金/印花税/其他」三列；
 *    旧列名「单价」「费用」零残留。
 * 2. 三统计块口径（用户原话逐字对齐）：
 *    - 买入金额 = 当前表内买入方向(side=BUY_SEC)成交额合计（qty × costPrice）
 *    - 卖出金额 = 当前表内卖出方向(side=SELL_SEC)成交额合计
 *    - 累计费用 = 当前表内「费用合计」列(feeTotal)之和
 * 3. 三统计块随筛选集合动态变化（统一筛选器作用后的可见结果集）。
 *
 * 平移自 React 版 web/src/features/security-trade/__tests__/security-trade-list-stats.test.tsx。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecurityTradeList from '../components/SecurityTradeList.vue';
import { formatCurrency } from '@/lib/utils';
import type { SecurityTradeResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------
const apiMocks = vi.hoisted(() => ({
  listSecurityTrades: vi.fn(),
  useSecurities: vi.fn(),
}));

vi.mock('@/api/security-trade.api', () => ({
  listSecurityTrades: apiMocks.listSecurityTrades,
}));
vi.mock('@/composables/use-securities', () => ({
  useSecurities: apiMocks.useSecurities,
}));
vi.mock('@/modules/security-trade/composables/use-security-trades', () => ({
  useDeleteSecurityTrade: () => ({ mutate: vi.fn(), isPending: { value: false } }),
}));
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function installJsdomPolyfills(): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

function makeTrade(
  seed: Partial<SecurityTradeResponse> &
    Pick<SecurityTradeResponse, 'id' | 'side' | 'quantity' | 'costPrice' | 'feeTotal'>,
): SecurityTradeResponse {
  return {
    portfolioId: 'pf-1',
    securityId: 's-1',
    date: '2025-07-15',
    commission: '0',
    stampTax: '0',
    other: '0',
    note: null,
    createdAt: '2025-07-15T00:00:00.000Z',
    updatedAt: '2025-07-15T00:00:00.000Z',
    ...seed,
  };
}

function mockPage(items: SecurityTradeResponse[]): void {
  apiMocks.listSecurityTrades.mockResolvedValue({
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
  });
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.listSecurityTrades.mockReset();
  apiMocks.useSecurities.mockReturnValue({ data: { value: [] } });
});

describe('证券买卖明细表 · 三统计块 + 列改名（INC-03）', () => {
  it('列头含改名后字段「成本价/费用合计/佣金/印花税/其他」，旧列名「单价/费用」零残留', async () => {
    mockPage([
      makeTrade({
        id: 't1',
        side: 'BUY_SEC',
        quantity: '100',
        costPrice: '1500.45',
        feeTotal: '5',
      }),
    ]);
    const wrapper = mountList();
    await settle();

    const headers = wrapper.findAll('th').map((th) => th.text());
    expect(headers).toContain('成本价');
    expect(headers).toContain('费用合计');
    expect(headers).toContain('佣金');
    expect(headers).toContain('印花税');
    expect(headers).toContain('其他');
    // 旧列名不应作为独立表头出现
    expect(headers).not.toContain('单价');
    expect(headers).not.toContain('费用');
  });

  it('三统计块口径正确：买入金额=ΣBUY qty×costPrice；卖出金额=ΣSELL；累计费用=ΣfeeTotal', async () => {
    mockPage([
      makeTrade({ id: 'b1', side: 'BUY_SEC', quantity: '100', costPrice: '1500.45', feeTotal: '5' }),
      makeTrade({ id: 'b2', side: 'BUY_SEC', quantity: '50', costPrice: '100', feeTotal: '2' }),
      makeTrade({ id: 's1', side: 'SELL_SEC', quantity: '30', costPrice: '200', feeTotal: '1' }),
    ]);
    const wrapper = mountList();
    await settle();

    // 买入 = 100*1500.45 + 50*100 = 150045 + 5000 = 155045
    expect(wrapper.text()).toContain(formatCurrency(155045, 2));
    // 卖出 = 30*200 = 6000
    expect(wrapper.text()).toContain(formatCurrency(6000, 2));
    // 累计费用 = 5 + 2 + 1 = 8
    expect(wrapper.text()).toContain(formatCurrency(8, 2));
  });

  it('筛选区间变化 → 三统计块同步变化（动态口径，统一筛选器作用后的可见结果集）', async () => {
    // 全集（模拟全年范围）
    mockPage([
      makeTrade({ id: 'b1', side: 'BUY_SEC', quantity: '100', costPrice: '1500.45', feeTotal: '5' }),
      makeTrade({ id: 'b2', side: 'BUY_SEC', quantity: '50', costPrice: '100', feeTotal: '2' }),
    ]);
    const wrapper = mountList({
      query: { startDate: '2025-01-01', endDate: '2025-12-31' },
    });
    await settle();
    expect(wrapper.text()).toContain(formatCurrency(155045, 2));

    // 切到仅 7 月子集（模拟日期筛选收紧）
    mockPage([
      makeTrade({ id: 'b1', side: 'BUY_SEC', quantity: '100', costPrice: '1500.45', feeTotal: '5' }),
    ]);
    await wrapper.setProps({
      query: { startDate: '2025-07-01', endDate: '2025-07-31' },
    });
    await settle();
    expect(wrapper.text()).toContain(formatCurrency(150045, 2));
    expect(wrapper.text()).not.toContain(formatCurrency(155045, 2));
  });
});

function mountList(props: Record<string, unknown> = {}): VueWrapper {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return mount(SecurityTradeList, {
    props: { portfolioId: 'pf-1', filterState: 'ready', ...props },
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
    attachTo: document.body,
  });
}
