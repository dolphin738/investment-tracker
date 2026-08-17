/**
 * modules/holdings/__tests__/inline-price-editor.test.ts — 现价内联编辑组件测试
 *
 * 覆盖（PRD §7.2【B】）：
 * 1. 展示态：渲染现价金额，点击进入编辑态（数字输入出现并带入当前值）
 * 2. Esc 取消：恢复展示态且不调用 API
 * 3. 回车保存：以今日 as-of + 新价格调用 upsertSecurityPrice
 *
 * API 与 toast 全部 mock，隔离网络与全局提示。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import InlinePriceEditor from '../components/InlinePriceEditor.vue';
import {
  upsertSecurityPrice as upsertApi,
} from '@/api/security-price.api';
import { toIsoDate } from '@/lib/constants';

vi.mock('@/api/security-price.api', () => ({
  upsertSecurityPrice: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

let pinia: Pinia;
let queryClient: QueryClient;

async function mountEditor(overrides: Record<string, unknown> = {}) {
  const wrapper = mount(InlinePriceEditor, {
    props: {
      portfolioId: 'p1',
      securityId: 's-a',
      value: 12.5,
      priceAsOf: '2026-06-01',
      flag: 'EXACT',
      ...overrides,
    },
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await flushPromises();
  return wrapper;
}

/** 等待 mutation 微任务链 + tanstack query 批量通知全部落地 */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  (upsertApi as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'sp-1',
    portfolioId: 'p1',
    securityId: 's-a',
    price: '13.0',
    asOf: toIsoDate(new Date()),
    createdAt: '2026-08-17T00:00:00Z',
  });
});

describe('InlinePriceEditor 现价内联编辑', () => {
  it('展示态渲染现价，点击进入编辑态并带入当前值', async () => {
    const wrapper = await mountEditor();
    expect(wrapper.text()).toContain('12.5');
    // COST_BASED 提示文案
    await wrapper.setProps({ flag: 'COST_BASED', priceAsOf: null });
    const btn = wrapper.find('button');
    expect(btn.attributes('title')).toBe(
      '暂无现价记录，当前按成本估值，点击录入现价',
    );
    await btn.trigger('click');
    const input = wrapper.find('input[type="number"]');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('12.5');
  });

  it('Esc 取消：恢复展示态且不调用 API', async () => {
    const wrapper = await mountEditor();
    await wrapper.find('button').trigger('click');
    const input = wrapper.find('input[type="number"]');
    await input.setValue('99');
    await input.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('input[type="number"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('12.5');
    expect(upsertApi).not.toHaveBeenCalled();
  });

  it('回车保存：以今日 as-of + 新价格调用 upsert', async () => {
    const wrapper = await mountEditor();
    await wrapper.find('button').trigger('click');
    const input = wrapper.find('input[type="number"]');
    await input.setValue('13.0');
    await input.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(upsertApi).toHaveBeenCalledTimes(1);
    expect(upsertApi).toHaveBeenCalledWith('p1', {
      securityId: 's-a',
      asOf: toIsoDate(new Date()),
      price: 13,
    });
    // 保存成功后退出编辑态
    expect(wrapper.find('input[type="number"]').exists()).toBe(false);
  });
});
