/**
 * modules/dividend-yield/__tests__/top-page.test.ts — 展示页（§10.3）核心契约
 *
 * 守护：/top20 双榜渲染（top + consecutive，P0-4 前端消费）；
 * 「查看全部」出口带 min_consecutive=2 跳转管理页（§10.3）。
 * mock api 层，Pinia/router/vue-query 真实（对齐 dashboard-page 测试脚手架）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import TopPage from '../pages/TopPage.vue';
import type { DividendYieldRankItem, DividendYieldTop20Response } from '@/api/types';

const fixtures = vi.hoisted(() => ({
  top20: { top: [], consecutive: [] } as unknown as DividendYieldTop20Response,
}));

vi.mock('@/api/dividend-yield.api', () => ({
  getDividendYieldTop20: vi.fn(async () => fixtures.top20),
  getDividendYieldSettings: vi.fn(async () => null),
  getDividendYieldCurve: vi.fn(),
  getDividendYieldImpliedPrice: vi.fn(),
}));
vi.mock('@/api/quote-interface.api', () => ({
  listAllInterfaces: vi.fn(async () => []),
}));

function item(code: string, over: Partial<DividendYieldRankItem> = {}): DividendYieldRankItem {
  return {
    master_id: `m-${code}`,
    code,
    name: `证券${code}`,
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
    ...over,
  };
}

describe('TopPage（§10.3 展示页）', () => {
  let pinia: Pinia;
  let router: Router;

  beforeEach(async () => {
    setActivePinia(createPinia());
    pinia = createPinia();
    setActivePinia(pinia);
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/dividend-yield/top', component: TopPage },
        { path: '/dividend-yield', component: { template: '<div />' } },
      ],
    });
    await router.push('/dividend-yield/top');
    await router.isReady();
  });

  async function mountPage(): Promise<VueWrapper> {
    const wrapper = mount(TopPage, {
      global: {
        plugins: [pinia, router, [VueQueryPlugin, { queryClient: new QueryClient() }]],
      },
    });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    return wrapper;
  }

  it('渲染双榜：top 榜与连续分红榜（P0-4 前端消费 /top20 双榜）', async () => {
    fixtures.top20 = {
      top: [item('600001'), item('600002')],
      consecutive: [item('600001', { consecutive_years: 5 })],
    };
    const wrapper = await mountPage();
    expect(wrapper.findAll('table').length).toBe(2);
    // top 2 行 + 连续榜 1 行
    expect(wrapper.findAll('tbody tr').length).toBe(3);
    expect(wrapper.text()).toContain('600002');
    expect(wrapper.text()).toContain('5 年');
  });

  it('空数据显示空态而非抛错', async () => {
    fixtures.top20 = { top: [], consecutive: [] };
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain('暂无股息率数据');
    expect(wrapper.findAll('table').length).toBe(0);
  });

  it('「查看全部」出口带 min_consecutive=2 跳转管理页（§10.3）', async () => {
    fixtures.top20 = { top: [], consecutive: [] };
    const wrapper = await mountPage();
    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('查看全部'));
    expect(btn).toBeDefined();
    await btn!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/dividend-yield');
    expect(router.currentRoute.value.query.min_consecutive).toBe('2');
  });
});
