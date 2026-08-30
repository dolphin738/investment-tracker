/**
 * modules/security-price/__tests__/security-price.test.ts — 行情价格模块测试
 *
 * 覆盖行为矩阵：
 * 1. 行情同步成功：点击按钮 → 触发 sync_portfolio_prices，toast 成功
 * 2. 行情同步失败：API 拒绝 → toast 失败
 * 3. 行情同步进行中：按钮禁用 + 旋转图标 + 「同步中」文案
 * 4. 价格历史空态：无任何记录 → EmptyState
 * 5. 价格历史列表：有记录 → 渲染行
 *
 * API 与 toast 全部 mock，隔离网络与全局提示。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SyncPricesButton from '../components/SyncPricesButton.vue';
import PriceHistoryList from '../components/PriceHistoryList.vue';
import { toast } from '@/composables/use-toast';
import { syncPortfolioPrices as syncApi } from '@/api/portfolio-price.api';
import { listSecurityPrices as listApi } from '@/api/security-price.api';

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/api/portfolio-price.api', () => ({
  syncPortfolioPrices: vi.fn(),
  getPriceSyncStatus: vi.fn(),
}));

vi.mock('@/api/security-price.api', () => ({
  listSecurityPrices: vi.fn(),
  upsertSecurityPrice: vi.fn(),
}));

let pinia: Pinia;
let queryClient: QueryClient;

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

function mountWithQuery(component: unknown, props: Record<string, unknown>): VueWrapper {
  return mount(component, {
    props,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe('SyncPricesButton 行情同步', () => {
  it('成功：点击触发 sync_portfolio_prices 并 toast 成功', async () => {
    (syncApi as ReturnType<typeof vi.fn>).mockResolvedValue({
      synced: 3,
      failed: 0,
      skipped: 0,
      errors: [],
    });
    const wrapper = mountWithQuery(SyncPricesButton, { portfolioId: 'p1' });
    await wrapper.find('button').trigger('click');
    await settle();
    expect(syncApi).toHaveBeenCalledTimes(1);
    expect(syncApi).toHaveBeenCalledWith('p1');
    expect(toast.success).toHaveBeenCalledWith('行情同步完成');
  });

  it('成功但存在失败条目时以失败 toast 提示', async () => {
    (syncApi as ReturnType<typeof vi.fn>).mockResolvedValue({
      synced: 3,
      failed: 1,
      skipped: 0,
      errors: ['quote failed'],
    });
    const wrapper = mountWithQuery(SyncPricesButton, { portfolioId: 'p1' });
    await wrapper.find('button').trigger('click');
    await settle();
    expect(toast.error).toHaveBeenCalledWith('行情同步完成，但有 1 条失败');
  });

  it('失败：API 拒绝 → toast 失败', async () => {
    (syncApi as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const wrapper = mountWithQuery(SyncPricesButton, { portfolioId: 'p1' });
    await wrapper.find('button').trigger('click');
    await settle();
    expect(toast.error).toHaveBeenCalledWith('行情同步失败，请稍后重试');
  });

  it('进行中：按钮禁用、显示旋转图标与「同步中」', async () => {
    let resolveSync!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveSync = resolve;
    });
    (syncApi as ReturnType<typeof vi.fn>).mockReturnValue(pending);
    const wrapper = mountWithQuery(SyncPricesButton, { portfolioId: 'p1' });
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('button').attributes()).toHaveProperty('disabled');
    expect(wrapper.text()).toContain('同步中');
    expect(wrapper.find('.animate-spin').exists()).toBe(true);
    // 收尾释放，避免悬挂 promise 影响其它用例
    resolveSync({ synced: 1, failed: 0, skipped: 0, errors: [] });
    await settle();
  });

  it('无组合：按钮禁用且点击不触发请求', async () => {
    const wrapper = mountWithQuery(SyncPricesButton, { portfolioId: null });
    expect(wrapper.find('button').attributes()).toHaveProperty('disabled');
    await wrapper.find('button').trigger('click');
    await settle();
    expect(syncApi).not.toHaveBeenCalled();
  });
});

describe('PriceHistoryList 价格历史', () => {
  it('空态：无任何记录时展示 EmptyState 提示', async () => {
    (listApi as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const wrapper = mountWithQuery(PriceHistoryList, { portfolioId: 'p1' });
    await settle();
    expect(wrapper.text()).toContain('暂无价格历史');
    expect(wrapper.find('table').exists()).toBe(false);
  });

  it('列表：渲染各估值日期与价格', async () => {
    (listApi as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: 'sp-1',
          portfolioId: 'p1',
          securityId: 's-a',
          price: '13.5',
          asOf: '2026-08-01',
          createdAt: '2026-08-01T00:00:00Z',
        },
        {
          id: 'sp-2',
          portfolioId: 'p1',
          securityId: 's-a',
          price: '12.0',
          asOf: '2026-07-01',
          createdAt: '2026-07-01T00:00:00Z',
        },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    const wrapper = mountWithQuery(PriceHistoryList, { portfolioId: 'p1' });
    await settle();
    const cells = wrapper.findAll('tbody tr');
    expect(cells).toHaveLength(2);
    expect(wrapper.text()).toContain('2026-08-01');
    expect(wrapper.text()).toContain('13.5');
    expect(wrapper.text()).toContain('12');
  });

  it('无组合：展示请先选择投资组合', async () => {
    const wrapper = mountWithQuery(PriceHistoryList, { portfolioId: null });
    await settle();
    expect(wrapper.text()).toContain('请先选择投资组合');
    expect(listApi).not.toHaveBeenCalled();
  });
});