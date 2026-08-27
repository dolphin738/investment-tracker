/**
 * modules/cashflow/__tests__/cashflow-list.test.ts — 出入金流水列表测试
 *
 * 覆盖：
 * 1. 渲染行：BUY 显示「存入」+ 金额前缀 +，SELL 显示「取出」+ 前缀 -
 * 2. 空态：无数据时显示「暂无出入金流水」，且无「清除筛选」按钮（无筛选条件）
 * 3. 空态 + 非默认筛选：显示「清除筛选」按钮并回调父级
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import CashflowList from '../components/CashflowList.vue';
import type { TransactionResponse } from '@/api/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast
// ---------------------------------------------------------------------------

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listTransactions: vi.fn(),
  createTransaction: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
}));

vi.mock('@/api/transaction.api', () => apiMocks);

// ---------------------------------------------------------------------------
// 测试夹具（一条 BUY、一条 SELL，与 React 版测试同构）
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui Dialog / Select 需要） */

const base = {
  portfolioId: 'pf-1',
  note: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const items: TransactionResponse[] = [
  { ...base, id: 'tx-buy', date: '2024-03-01', type: 'BUY', amount: '1000.00' },
  { ...base, id: 'tx-sell', date: '2024-03-02', type: 'SELL', amount: '500.00' },
];

let wrapper: VueWrapper | null = null;

function mountList(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(CashflowList, {
    props: {
      portfolioId: 'pf-1',
      page: 1,
      pageSize: 20,
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
      ...props,
    },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.listTransactions.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('CashflowList — 出入金流水列表', () => {
  it('渲染行：BUY 存入（+ 前缀）/ SELL 取出（- 前缀），按行绑定正确', async () => {
    apiMocks.listTransactions.mockResolvedValue({
      items,
      total: items.length,
      page: 1,
      pageSize: 20,
    });
    mountList();
    await flushPromises();

    const rows = wrapper!.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    // BUY 行：存入 + 前缀（枚举与文案绑定正确，防映射写反）
    expect(rows[0].text()).toContain('存入');
    expect(rows[0].text()).toContain('+');
    expect(rows[0].text()).not.toContain('取出');
    // SELL 行：取出 - 前缀
    expect(rows[1].text()).toContain('取出');
    expect(rows[1].text()).toContain('-');
    expect(rows[1].text()).not.toContain('存入');
    // 分页信息
    expect(wrapper!.text()).toContain('共 2 条 · 第 1/1 页');
  });

  it('空态：无数据时显示「暂无出入金流水」，无筛选条件时不显示「清除筛选」', async () => {
    apiMocks.listTransactions.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    mountList();
    await flushPromises();

    expect(wrapper!.text()).toContain('暂无出入金流水');
    expect(wrapper!.text()).not.toContain('清除筛选');
  });

  it('空态 + 非默认筛选：显示「清除筛选」并回调父级', async () => {
    apiMocks.listTransactions.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    });
    const onClearFilter = vi.fn();
    // page: 2 即非默认筛选条件
    mountList({ page: 2, onClearFilter });
    await flushPromises();

    expect(wrapper!.text()).toContain('清除筛选');
    // 找到「清除筛选」按钮并点击
    const clearBtn = wrapper!
      .findAll('button')
      .find((b) => b.text().includes('清除筛选'));
    expect(clearBtn).toBeDefined();
    await clearBtn!.trigger('click');
    expect(onClearFilter).toHaveBeenCalled();
  });
});
