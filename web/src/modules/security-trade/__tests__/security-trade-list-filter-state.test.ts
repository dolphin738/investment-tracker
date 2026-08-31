/**
 * modules/security-trade/__tests__/security-trade-list-filter-state.test.ts
 * — filterState 短路（缺陷4 二次修复）
 *
 * 回归重点：持仓页类型筛选器命中为空时，列表必须显示空态，
 * **绝不能**因为「没传 securityId」而向后端发出无过滤查询、回显全量交易。
 *
 * 平移自 React 版 web/src/features/security-trade/__tests__/security-trade-list-filter-state.test.tsx。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecurityTradeList from '../components/SecurityTradeList.vue';
import type { SecurityTradeResponse } from '@/api/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层（组件直接调用 listSecurityTrades + useSecurities，不走 useSecurityTrades 封装）
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

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 等待 vue-query notifyManager 调度完成 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

function mountList(props: Record<string, unknown> = {}): VueWrapper {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return mount(SecurityTradeList, {
    props: { portfolioId: 'pf-1', ...props },
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
    attachTo: document.body,
  });
}

function makeTrade(id: string): SecurityTradeResponse {
  return {
    id,
    portfolioId: 'pf-1',
    securityId: 's-1',
    date: '2025-08-15',
    side: 'BUY_SEC',
    quantity: '100',
    costPrice: '10',
    commission: '0',
    stampTax: '0',
    other: '0',
    feeTotal: '0',
    note: null,
    createdAt: '2025-08-15T00:00:00.000Z',
    updatedAt: '2025-08-15T00:00:00.000Z',
  };
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.listSecurityTrades.mockReset();
  apiMocks.useSecurities.mockReturnValue({ data: { value: [] } });
});

describe('SecurityTradeList · filterState 短路', () => {
  it('默认 filterState=ready → 正常查询并渲染数据', async () => {
    apiMocks.listSecurityTrades.mockResolvedValue({
      items: [makeTrade('t-1'), makeTrade('t-2')],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    const wrapper = mountList({ filterState: 'ready' });
    await settle();
    expect(apiMocks.listSecurityTrades).toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('暂无买卖流水');
  });

  it('filterState=empty → 不发查询（组件短路）且渲染空态', async () => {
    apiMocks.listSecurityTrades.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const wrapper = mountList({
      filterState: 'empty',
      filteredEmptyText: '当前筛选条件下没有匹配的标的，暂无买卖流水',
    });
    await settle();
    expect(apiMocks.listSecurityTrades).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(
      '当前筛选条件下没有匹配的标的，暂无买卖流水',
    );
  });

  it('filterState=empty 未给 filteredEmptyText 时回落 emptyText', async () => {
    apiMocks.listSecurityTrades.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const wrapper = mountList({ filterState: 'empty' });
    await settle();
    expect(wrapper.text()).toContain('暂无买卖流水');
  });

  it('filterState=loading → 不发查询且渲染骨架（不闪全量数据）', async () => {
    apiMocks.listSecurityTrades.mockResolvedValue({
      items: [makeTrade('t-1')],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const wrapper = mountList({ filterState: 'loading' });
    await settle();
    expect(apiMocks.listSecurityTrades).not.toHaveBeenCalled();
    // 骨架占位存在，且没有任何表格行
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('暂无买卖流水');
  });
});
