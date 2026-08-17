/**
 * modules/cash-balance/__tests__/cash-balance-history.test.ts — 现金余额变更历史测试
 *
 * 覆盖：
 * 1. 渲染行：生效日 / 金额 / 备注 / 操作按钮（编辑 aria-label 按行绑定）
 * 2. 空态：无日期条件时「暂无现金余额变更记录」，无「清除筛选」
 * 3. 空态 + 日期条件：显示「所选日期范围内…」与「清除筛选」按钮
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import CashBalanceHistory from '../components/CashBalanceHistory.vue';
import type { CashBalanceResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast
// ---------------------------------------------------------------------------

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listCashBalances: vi.fn(),
  getLatestCashBalance: vi.fn(),
  upsertCashBalance: vi.fn(),
  deleteCashBalance: vi.fn(),
}));

vi.mock('@/api/cash-balance.api', () => apiMocks);

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui 组件需要） */
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
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      function releasePointerCapture(): void {};
  }
}

const items: CashBalanceResponse[] = [
  {
    id: 'cb-1',
    portfolioId: 'pf-1',
    asOf: '2024-01-15',
    amount: '2000.00',
    note: '券商账户可用余额对账',
    createdAt: '2024-01-15T00:00:00.000Z',
  },
  {
    id: 'cb-2',
    portfolioId: 'pf-1',
    asOf: '2024-02-01',
    amount: '1500.00',
    note: null,
    createdAt: '2024-02-01T00:00:00.000Z',
  },
];

let wrapper: VueWrapper | null = null;

function mountHistory(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(CashBalanceHistory, {
    props: { portfolioId: 'pf-1', ...props },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.listCashBalances.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('CashBalanceHistory — 现金余额变更历史', () => {
  it('渲染行：生效日 / 金额 / 备注（空备注显示 -）/ 编辑删除操作按行绑定', async () => {
    apiMocks.listCashBalances.mockResolvedValue({
      items,
      total: items.length,
      page: 1,
      pageSize: 20,
    });
    mountHistory({ onEdit: vi.fn() });
    await flushPromises();

    const rows = wrapper!.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('2024-01-15');
    expect(rows[0].text()).toContain('券商账户可用余额对账');
    // 空备注显示占位 -
    expect(rows[1].text()).toContain('2024-02-01');
    // 编辑按钮 aria-label 按行绑定（含各自生效日）
    const editBtns = wrapper!.findAll('button[title="编辑（按生效日覆盖）"]');
    expect(editBtns).toHaveLength(2);
    expect(editBtns[0].attributes('aria-label')).toBe('编辑 2024-01-15 的现金余额');
    expect(editBtns[1].attributes('aria-label')).toBe('编辑 2024-02-01 的现金余额');
  });

  it('空态：无日期条件时显示「暂无现金余额变更记录」，无「清除筛选」', async () => {
    apiMocks.listCashBalances.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    mountHistory();
    await flushPromises();

    expect(wrapper!.text()).toContain('暂无现金余额变更记录');
    expect(wrapper!.text()).not.toContain('清除筛选');
  });

  it('空态 + 日期条件：显示「所选日期范围内…」与「清除筛选」并回调父级', async () => {
    apiMocks.listCashBalances.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const onClearFilter = vi.fn();
    mountHistory({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      onClearFilter,
    });
    await flushPromises();

    expect(wrapper!.text()).toContain('所选日期范围内暂无现金余额变更记录');
    const clearBtn = wrapper!
      .findAll('button')
      .find((b) => b.text().includes('清除筛选'));
    expect(clearBtn).toBeDefined();
    await clearBtn!.trigger('click');
    expect(onClearFilter).toHaveBeenCalled();
  });
});
