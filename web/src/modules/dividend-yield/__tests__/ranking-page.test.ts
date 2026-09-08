/**
 * modules/dividend-yield/__tests__/ranking-page.test.ts — 管理页（§10.2）核心契约
 *
 * 守护：§8.1 过滤参数透传（include_proposed / min_consecutive 等）；
 * URL query 初始化过滤（§10.3 TopPage「查看全部」跳入契约）；
 * 覆盖度计数渲染（§1.3）。mock api 层，Pinia/router/vue-query 真实。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import RankingPage from '../pages/RankingPage.vue';
import type { DividendYieldRankFilters } from '@/api/dividend-yield.api';

const fixtures = vi.hoisted(() => ({
  /** 捕获每次 getDividendYieldRank 的过滤参数 */
  calls: [] as DividendYieldRankFilters[],
  total: 0,
}));

vi.mock('@/api/dividend-yield.api', () => ({
  getDividendYieldRank: vi.fn(
    async (
      _page: number,
      _pageSize: number,
      _sort: string,
      filters: DividendYieldRankFilters,
    ) => {
      fixtures.calls.push(filters);
      return {
        items: [
          {
            master_id: 'm-600001',
            code: '600001',
            name: '证券600001',
            exchange: 'SH',
            mode: 'TTM',
            dividend_yield: 0.08,
            numerator_per_share: 1,
            latest_price: 12.5,
            latest_trade_date: '2026-09-04',
            consecutive_years: 3,
            last_dividend_year: 2026,
            stale: false,
            suspicious: false,
            computed_at: null,
          },
        ],
        total: fixtures.total,
        page: _page,
        pageSize: _pageSize,
      };
    },
  ),
  getDividendYieldSettings: vi.fn(async () => null),
  getDividendYieldCurve: vi.fn(),
  getDividendYieldImpliedPrice: vi.fn(),
  searchDividendYieldSecurities: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@/api/quote-interface.api', () => ({
  listAllInterfaces: vi.fn(async () => []),
}));

describe('RankingPage（§10.2 管理页）', () => {
  let pinia: Pinia;
  let router: Router;

  beforeEach(() => {
    fixtures.calls = [];
    fixtures.total = 1;
    pinia = createPinia();
    setActivePinia(pinia);
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/dividend-yield', component: RankingPage },
        { path: '/dividend-yield/top', component: { template: '<div />' } },
      ],
    });
  });

  async function mountAt(fullPath: string): Promise<VueWrapper> {
    await router.push(fullPath);
    await router.isReady();
    const wrapper = mount(RankingPage, {
      global: {
        plugins: [pinia, router, [VueQueryPlugin, { queryClient: new QueryClient() }]],
      },
    });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    return wrapper;
  }

  it('覆盖度计数渲染（§1.3）', async () => {
    fixtures.total = 42;
    const wrapper = await mountAt('/dividend-yield');
    expect(wrapper.text()).toContain('覆盖 42 家');
  });

  it('URL query min_consecutive 初始化过滤（§10.3「查看全部」跳入契约）', async () => {
    await mountAt('/dividend-yield?min_consecutive=2');
    expect(fixtures.calls.length).toBeGreaterThan(0);
    expect(fixtures.calls[0]?.min_consecutive).toBe(2);
    // 默认剔除近两年无分红（§8.2 include_no_dividend=false）
    expect(fixtures.calls[0]?.include_no_dividend).toBe(false);
  });

  it('默认参数透传：含预案、剔除两年无分红', async () => {
    await mountAt('/dividend-yield');
    expect(fixtures.calls[0]?.include_proposed).toBe(true);
    expect(fixtures.calls[0]?.include_no_dividend).toBe(false);
    expect(fixtures.calls[0]?.exchange).toBeUndefined();
    expect(fixtures.calls[0]?.mode).toBeUndefined();
  });
});
