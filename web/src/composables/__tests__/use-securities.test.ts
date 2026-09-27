/**
 * composables/__tests__/use-securities.test.ts — useSecurities 翻页拉全回归
 *
 * 守护：持仓页（及买卖/分红表单）点开即弹「Input should be less than or equal to 200」的根因是
 * 前端曾一次性请求 pageSize=500，命中后端 GET /portfolios/:portfolioId/securities 的 le=200 约束。
 * 修复后 useSecurities 内部按 200/页翻页拉全；本测试守卫「翻页拼接完整字典」且「单页即停不冗余请求」。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { Security } from '@/api/types';
import { useSecurities } from '../use-securities';

const fixtures = vi.hoisted(() => ({
  pages: [] as Array<{ items: Security[]; total: number; page: number; pageSize: number }>,
}));

vi.mock('@/api/security.api', () => ({
  SECURITY_LIST_PAGE_SIZE: 200,
  listSecurities: vi.fn(
    async (_pid: string, _pageSize: number, page: number) =>
      fixtures.pages[page - 1] ?? { items: [], total: 0, page, pageSize: 200 },
  ),
}));

function stub(n: number, prefix = 's'): Security[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }) as Security);
}

function mountHarness() {
  const Comp = defineComponent({
    setup() {
      const q = useSecurities('p-1');
      return () => h('div', { 'data-count': String(q.data.value?.length ?? 0) });
    },
  });
  return mount(Comp, {
    global: {
      plugins: [
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        ],
      ],
    },
  });
}

describe('useSecurities（翻页拉全，§标的字典）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('多页：拼接为完整字典，且恰好翻到末页即停', async () => {
    fixtures.pages = [
      { items: stub(200), total: 250, page: 1, pageSize: 200 },
      { items: stub(50, 't'), total: 250, page: 2, pageSize: 200 },
    ];
    const wrapper = mountHarness();
    await flushPromises();

    expect(wrapper.attributes('data-count')).toBe('250');
    // 第 1 页装满 200 → 翻第 2 页（50）→ 末页不足一页即停，不发第 3 页
    const api = await import('@/api/security.api');
    expect((api.listSecurities as Mock).mock.calls.length).toBe(2);
  });

  it('单页：不足一页时不发多余请求', async () => {
    fixtures.pages = [{ items: stub(3), total: 3, page: 1, pageSize: 200 }];
    const wrapper = mountHarness();
    await flushPromises();

    expect(wrapper.attributes('data-count')).toBe('3');
    const api = await import('@/api/security.api');
    expect((api.listSecurities as Mock).mock.calls.length).toBe(1);
  });

  it('护栏：恒返满页（后端分页异常）时在页数上限抛错，不做无限翻页', async () => {
    // 每页都「装满 200」→ 后端分页异常场景；页数上限 50，第 51 页请求前中止
    fixtures.pages = Array.from({ length: 200 }, (_, i) => ({
      items: stub(200, `p${i}`),
      total: Number.POSITIVE_INFINITY,
      page: i + 1,
      pageSize: 200,
    }));
    const wrapper = mountHarness();
    await flushPromises();

    // error 态：select 未产出数据 → data-count '0'
    expect(wrapper.attributes('data-count')).toBe('0');
    const api = await import('@/api/security.api');
    expect((api.listSecurities as Mock).mock.calls.length).toBe(50);
  });
});
