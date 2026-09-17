/**
 * QA 独立验证：全局设置页「初始化」独立 Tab 重构（提交 c5d638e）。
 *
 * 本文件由独立 QA 编写，不复用工程师测试文件，独立断言需求 3 条：
 *  - [初始化][股息率] 顺序正确、默认激活「初始化」；
 *  - 唯一 settingsForm 状态源：跨 TAB 改动互不丢失，保存仅发一次 PUT；
 *  - 「不复权」哨兵双向映射：服务端 '' → 下拉显示「不复权」选中；选「不复权」→ 提交 ''（非哨兵）；
 *  - 「回补复权方式」与「回补模式」同一 2 列网格并排。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';
import type { DividendYieldSettingsOut } from '@/api/types';

const interfaces = vi.hoisted(() => [
  { id: 'i1', provider_id: 'p1', category_id: '3', name: '东财-分红配送', enabled: true },
  { id: 'i2', provider_id: 'p2', category_id: '3', name: '新浪-分红配股', enabled: true },
  { id: 'i3', provider_id: 'p1', category_id: '2', name: '腾讯财经-A股行情', enabled: true },
  { id: 'i4', provider_id: 'p1', category_id: '4', name: '沪深京A股公告', enabled: true },
]);

const providers = vi.hoisted(() => [
  { id: 'p1', name: '东方财富' },
  { id: 'p2', name: '新浪财经' },
]);

const settings = vi.hoisted<DividendYieldSettingsOut>(() => ({
  dividend_report_source: { id: 'i1', name: '东财-分红配送' },
  dividend_detail_source: { id: 'i2', name: '新浪-分红配股' },
  price_source: { id: 'i3', name: '腾讯财经-A股行情' },
  announcement_source: null,
  price_backfill_source: null,
  price_backfill_start_date: null,
  price_backfill_default_start_date: null,
  price_backfill_quota: null,
  price_backfill_used_today: 0,
  price_backfill_last_error: null,
  trade_calendar_start_date: null,
  price_backfill_mode: 'legacy',
  price_backfill_adjust: '',
}));

const mutateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modules/dividend-yield/composables/use-dividend-yield', () => ({
  useDividendYieldSettings: () => ({ data: ref(settings), isLoading: ref(false) }),
  useDividendYieldInterfaces: () => ({ data: ref(interfaces) }),
  useUpdateDividendYieldSettings: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: mutateSpy,
  }),
  useRebuildDividendYield: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
  useBackfillSpecialDividends: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
  useBackfillDividendPrices: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
  useCancelPriceBackfill: () => ({ isPending: ref(false), isError: ref(false), mutate: vi.fn() }),
}));

vi.mock('@/modules/admin/composables/use-quote-provider', () => ({
  useQuoteProviders: () => ({ data: ref(providers) }),
}));

vi.mock('@/stores/auth.store', () => ({ useIsAdmin: () => true }));

// reka-ui Select → <select>/<option> 替身（id 由 SelectTrigger 转接，按锚点定位）
vi.mock('@/components/ui/select', async () => {
  await import('vue');
  const Select = defineComponent({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () => {
        const children = slots.default?.() ?? [];
        const triggerId = children
          .map((v) => (v && typeof v === 'object' ? v.props : null))
          .find((p) => p && typeof p === 'object' && 'id' in p)?.id;
        return h(
          'select',
          {
            id: triggerId,
            value: props.modelValue ?? '',
            'data-testid': 'select',
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          [h('option', { key: '__ph', value: '' }, ''), children],
        );
      };
    },
  });
  const SelectItem = defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      return () => h('option', { value: props.value }, slots.default?.());
    },
  });
  const passthrough = defineComponent({ setup(_, { slots }) { return () => slots.default?.(); } });
  const renderNothing = defineComponent({ setup() { return () => null; } });
  return {
    Select,
    SelectItem,
    SelectTrigger: renderNothing,
    SelectValue: renderNothing,
    SelectContent: passthrough,
    SelectGroup: passthrough,
    SelectLabel: renderNothing,
  };
});

// reka-ui Tabs → provide/inject 驱动的按钮（点击切页）
vi.mock('@/components/ui/tabs', async () => {
  const { defineComponent: dc, h: hh, provide, inject, computed } = await import('vue');
  const TABS_KEY = Symbol('tabs');
  const Tabs = dc({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      const model = computed({ get: () => props.modelValue, set: (v: string) => emit('update:modelValue', v) });
      provide(TABS_KEY, model);
      return () => slots.default?.();
    },
  });
  const TabsList = dc({ setup(_, { slots }) { return () => hh('div', { 'data-testid': 'tabs-list' }, slots.default?.()); } });
  const TabsTrigger = dc({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      const model = inject<{ value: string } | null>(TABS_KEY, null);
      return () => hh('button', { type: 'button', 'data-tab': props.value, onClick: () => { if (model) model.value = props.value; } }, slots.default?.());
    },
  });
  const TabsContent = dc({ setup(_, { slots }) { return () => slots.default?.(); } });
  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

import GlobalSettingsPage from '../pages/GlobalSettingsPage.vue';

let wrapper: VueWrapper;

async function mountPage(): Promise<VueWrapper> {
  const w = mount(GlobalSettingsPage);
  await flushPromises();
  return w;
}

async function switchTab(w: VueWrapper, tab: string): Promise<void> {
  await w.find(`[data-tab="${tab}"]`).trigger('click');
  await flushPromises();
}

function saveButton(w: VueWrapper) {
  return w.findAll('button').find((b) => b.text().includes('保存设置'))!;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.price_backfill_start_date = null;
  settings.price_backfill_quota = null;
  settings.price_backfill_used_today = 0;
  settings.price_backfill_last_error = null;
  settings.price_backfill_adjust = '';
});

describe('QA · 全局设置页 Tab 重构独立验证', () => {
  it('A. 标签栏顺序 [初始化][股息率] 且默认激活「初始化」', async () => {
    wrapper = await mountPage();
    const tabs = wrapper.findAll('[data-tab]');
    expect(tabs.map((t) => t.text())).toEqual(['初始化', '股息率']);
    expect(tabs.map((t) => t.attributes('data-tab'))).toEqual(['init', 'dividend']);
    // 默认激活初始化：复权下拉可见、股息率内容不在 DOM
    expect(wrapper.find('#dy-backfill-adjust').exists()).toBe(true);
    expect(wrapper.find('#dy-report-source').exists()).toBe(false);
    wrapper.unmount();
  });

  it('B1. 服务端 ""（不复权）→ 下拉显示「不复权」被选中（哨兵）', async () => {
    settings.price_backfill_adjust = '';
    wrapper = await mountPage();
    const sel = wrapper.find('#dy-backfill-adjust');
    expect((sel.element as HTMLSelectElement).value).toBe(SELECT_EMPTY_VALUE);
    wrapper.unmount();
  });

  it('B2. 选「不复权」→ 提交服务端值为 ""（不是哨兵串）', async () => {
    settings.price_backfill_adjust = 'qfq'; // 制造差异，使保存可用
    wrapper = await mountPage();
    await wrapper.find('#dy-backfill-adjust').setValue(SELECT_EMPTY_VALUE);
    await flushPromises();

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const payload = mutateSpy.mock.calls[0][0];
    expect(payload.price_backfill_adjust).toBe('');
    expect(payload.price_backfill_adjust).not.toBe(SELECT_EMPTY_VALUE);
    wrapper.unmount();
  });

  it('C. 跨 TAB 状态不丢 + 保存仅发一次 PUT', async () => {
    wrapper = await mountPage();

    // 初始化 TAB：改额度与复权方式
    await wrapper.find('input#dy-price-backfill-quota').setValue('1234');
    await wrapper.find('#dy-backfill-adjust').setValue('qfq');
    await flushPromises();

    // 切到股息率 TAB：把「行情源接口」改为「不设置」
    await switchTab(wrapper, 'dividend');
    await wrapper.find('#dy-price-source').setValue(SELECT_EMPTY_VALUE);
    await flushPromises();

    // 切回初始化：额度与复权值仍在
    await switchTab(wrapper, 'init');
    expect((wrapper.find('input#dy-price-backfill-quota').element as HTMLInputElement).value).toBe('1234');
    expect((wrapper.find('#dy-backfill-adjust').element as HTMLSelectElement).value).toBe('qfq');

    // 再切到股息率：行情源改动仍在
    await switchTab(wrapper, 'dividend');
    expect((wrapper.find('#dy-price-source').element as HTMLSelectElement).value).toBe(SELECT_EMPTY_VALUE);

    // 保存一次
    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const payload = mutateSpy.mock.calls[0][0];
    expect(payload.price_backfill_adjust).toBe('qfq');
    expect(payload.price_backfill_quota).toBe(1234);
    // 「不设置」哨兵 → 提交 null；阈值字段已迁「个人中心 → 偏好设置」，不再出现在本页 payload
    expect(payload.price_source_interface_id).toBeNull();
    expect(payload).not.toHaveProperty('green_threshold');
    wrapper.unmount();
  });

  it('D. 「回补复权方式」与「回补模式」在同一 2 列网格并排', async () => {
    wrapper = await mountPage();
    const modeSel = wrapper.find('#dy-backfill-mode');
    const adjustSel = wrapper.find('#dy-backfill-adjust');
    expect(modeSel.exists()).toBe(true);
    expect(adjustSel.exists()).toBe(true);
    const modeGrid = modeSel.element.closest('.grid');
    const adjustGrid = adjustSel.element.closest('.grid');
    expect(modeGrid).not.toBeNull();
    expect(modeGrid).toBe(adjustGrid);
    expect(modeGrid!.className).toContain('sm:grid-cols-2');
    expect(modeSel.element.closest('.space-y-2')!.className).not.toContain('sm:col-span-2');
    expect(adjustSel.element.closest('.space-y-2')!.className).not.toContain('sm:col-span-2');
    wrapper.unmount();
  });
});
