/**
 * modules/admin/__tests__/global-settings-dividend-tab.test.ts — 全局设置页测试
 *
 * 覆盖（对齐方案 §10.4/§15.3）：
 * 1. 顶层 TAB 顺序： [初始化][股息率]，默认激活「初始化」
 * 2. 「股息率」TAB 四源下拉选项过滤与「接口名（提供方名）」拼接
 *
 * Mock 策略：composables 层（useDividendYieldSettings / useDividendYieldInterfaces /
 * useUpdateDividendYieldSettings / useQuoteProviders）全部 mock；@/stores/auth.store 的
 * useIsAdmin 恒 true；reka-ui Select / Tabs 以轻量替身（原生 <select>/<option>、
 * provide/inject 驱动的按钮）渲染，便于断言与切换 TAB。
 *
 * 注：原「回补复权方式 / 回补模式 / 每日回补额度 / 在途 / 取消在途」等价格缺口回补用例
 * 已随价格缺口回补功能下线一并移除。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import { ROUTE_PATH, SELECT_EMPTY_VALUE } from '@/lib/constants';
import type { DividendYieldSettingsOut } from '@/api/types';

// ---------------------------------------------------------------------------
// 测试数据（模块级共享：mock 工厂与断言共用）
// ---------------------------------------------------------------------------

const interfaces = vi.hoisted(() => [
  { id: 'i1', provider_id: 'p1', category_id: '3', name: '东财-分红配送', enabled: true },
  { id: 'i2', provider_id: 'p2', category_id: '3', name: '新浪-分红配股', enabled: true },
  { id: 'i3', provider_id: 'p1', category_id: '2', name: '腾讯财经-A股行情', enabled: true },
  { id: 'i4', provider_id: 'p1', category_id: '4', name: '沪深京A股公告', enabled: true },
  // 分类 4 但未启用：不应出现在公司公告接口下拉
  { id: 'i5', provider_id: 'p2', category_id: '4', name: '东财-公告扫描', enabled: false },
]);

const providers = vi.hoisted(() => [
  { id: 'p1', name: '东方财富' },
  { id: 'p2', name: '新浪财经' },
]);

const settings = vi.hoisted<DividendYieldSettingsOut>(() => ({
  dividend_detail_source: { id: 'i2', name: '新浪-分红配股' },
  price_source: { id: 'i3', name: '腾讯财经-A股行情' },
  announcement_source: null,
  trade_calendar_start_date: null,
}));

const mutateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modules/dividend-yield/composables/use-dividend-yield', () => ({
  useDividendYieldSettings: () => ({
    data: ref(settings),
    isLoading: ref(false),
  }),
  useDividendYieldInterfaces: () => ({
    data: ref(interfaces),
  }),
  useUpdateDividendYieldSettings: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: mutateSpy,
  }),
  useRebuildDividendYield: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: vi.fn(),
  }),
  useSeedInitialDividends: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: vi.fn(),
  }),
}));

vi.mock('@/modules/admin/composables/use-quote-provider', () => ({
  useQuoteProviders: () => ({
    data: ref(providers),
  }),
}));

// 权限：恒为 admin（页面守卫放行）
vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => true,
}));

// 待人工划分入口按钮依赖的概览查询（三态可控：加载中不渲染 / 可点 / 置灰）
const pendingSummaryState = vi.hoisted(() => ({
  isLoading: false,
  data: { pending: 3 } as { pending: number } | undefined,
}));
vi.mock('@/modules/dividend-yield/composables/use-pending-dividends', async () => {
  const { ref } = await import('vue');
  return {
    usePendingDividendSummary: () => ({
      isLoading: ref(pendingSummaryState.isLoading),
      data: ref(pendingSummaryState.data),
    }),
  };
});

// 待人工划分入口按钮点击 → router.push（本页不引入真实 router）
const pushSpy = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushSpy }) }));

// reka-ui Select 原生替身：Select 渲染为 <select>，SelectItem 渲染为 <option>（可断言文本）。
// 关键：把子节点 SelectTrigger 上的 id 转接到替身 <select> 的 id，使测试可按
// #dy-report-source 等稳定锚点定位，不再依赖 DOM 顺序。
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
            class: 'select-stub',
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
  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
  const renderNothing = defineComponent({
    setup() {
      return () => null;
    },
  });
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

// reka-ui Tabs 替身：Tabs 用 provide 暴露可写 model，TabsTrigger 点击即切页（驱动 v-model）。
vi.mock('@/components/ui/tabs', async () => {
  const { defineComponent: dc, h: hh, provide, inject, computed } = await import('vue');
  const TABS_KEY = Symbol('tabs');
  const Tabs = dc({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      const model = computed({
        get: () => props.modelValue,
        set: (v: string) => emit('update:modelValue', v),
      });
      provide(TABS_KEY, model);
      return () => slots.default?.();
    },
  });
  const TabsList = dc({
    setup(_, { slots }) {
      return () => hh('div', { 'data-testid': 'tabs-list' }, slots.default?.());
    },
  });
  const TabsTrigger = dc({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      const model = inject<{ value: string } | null>(TABS_KEY, null);
      return () =>
        hh(
          'button',
          {
            type: 'button',
            'data-tab': props.value,
            onClick: () => {
              if (model) model.value = props.value;
            },
          },
          slots.default?.(),
        );
    },
  });
  const TabsContent = dc({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

import GlobalSettingsPage from '../pages/GlobalSettingsPage.vue';

let wrapper: VueWrapper;

/** 渲染页面并等待表单 watch 回填 */
async function mountPage(): Promise<VueWrapper> {
  const w = mount(GlobalSettingsPage);
  await flushPromises();
  return w;
}

/** 切到指定 TAB（替身按钮带 data-tab） */
async function switchTab(w: VueWrapper, tab: string): Promise<void> {
  await w.find(`[data-tab="${tab}"]`).trigger('click');
  await flushPromises();
}

/** 非空 option（跳过 Select 替身自带的占位空 option） */
function realOptions(select: DOMWrapper<Element>): DOMWrapper<Element>[] {
  return select.findAll('option').filter((o) => o.text().trim() !== '');
}

/** 接口 option（跳过「不设置」哨兵项与占位空 option） */
function interfaceOptions(select: DOMWrapper<Element>): DOMWrapper<Element>[] {
  return select
    .findAll('option')
    .filter(
      (o) => o.attributes('value') !== SELECT_EMPTY_VALUE && o.text().trim() !== '',
    );
}

/** 股息率 TAB 的三源接口下拉（稳定锚点，id 由 SelectTrigger 提供、替身 <select> 转接） */
const DIVIDEND_INTERFACE_SELECT_IDS = [
  'dy-detail-source',
  'dy-price-source',
  'dy-announcement-source',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  settings.trade_calendar_start_date = null;
  pendingSummaryState.isLoading = false;
  pendingSummaryState.data = { pending: 3 };
});

describe('GlobalSettingsPage — 顶层 TAB 与全局设置', () => {
  it('① 「初始化」是第一个 TAB 且默认激活', async () => {
    wrapper = await mountPage();

    // TAB 顺序：[初始化][股息率]
    const tabs = wrapper.findAll('[data-tab]');
    expect(tabs.map((t) => t.text())).toEqual(['初始化', '股息率']);
    expect(tabs[0].attributes('data-tab')).toBe('init');

    // 默认激活「初始化」：交易日历输入可见，股息率内容不可见
    expect(wrapper.find('#dy-trade-calendar-start').exists()).toBe(true);
    expect(wrapper.find('#dy-report-source').exists()).toBe(false);

    wrapper.unmount();
  });

  it('② 股息率 TAB：四源下拉过滤 + 「接口名（提供方名）」拼接', async () => {
    wrapper = await mountPage();
    await switchTab(wrapper, 'dividend');

    // 页面含「公司公告接口」区块
    expect(wrapper.text()).toContain('公司公告接口');
    // 已移除的「回补模式 / 复权方式」属旧配置，切走后不在 DOM
    expect(wrapper.find('#dy-backfill-mode').exists()).toBe(false);

    // 公司公告接口下拉（按 id 锚定）：仅含启用的分类 4 接口
    expect(
      interfaceOptions(wrapper.find('#dy-announcement-source')).map((o) =>
        o.attributes('value'),
      ),
    ).toEqual(['i4']);
    // 每个接口下拉都提供「不设置」哨兵项、且无空串 value
    DIVIDEND_INTERFACE_SELECT_IDS.forEach((id) => {
      const sel = wrapper.find(`#${id}`);
      expect(sel.exists()).toBe(true);
      expect(
        realOptions(sel).some((o) => o.attributes('value') === SELECT_EMPTY_VALUE),
      ).toBe(true);
      expect(realOptions(sel).some((o) => o.attributes('value') === '')).toBe(false);
    });
    // 提供方名反查生效
    expect(
      interfaceOptions(wrapper.find('#dy-detail-source'))[1].text(),
    ).toBe('新浪-分红配股（新浪财经）');
    expect(
      interfaceOptions(wrapper.find('#dy-announcement-source'))[0].text(),
    ).toBe('沪深京A股公告（东方财富）');

    wrapper.unmount();
  });

  it('③ 待人工划分入口按钮三态：加载中不渲染 / pending>0 可点跳转 / pending=0 置灰不隐藏', async () => {
    // 加载中 → 不渲染入口按钮
    pendingSummaryState.isLoading = true;
    wrapper = await mountPage();
    expect(
      wrapper
        .findAll('button')
        .some(
          (b) =>
            b.text().includes('待人工划分') || b.text().includes('暂无待划分'),
        ),
    ).toBe(false);
    wrapper.unmount();

    // pending > 0 → 可点，点击跳转到待划分页
    pendingSummaryState.isLoading = false;
    pendingSummaryState.data = { pending: 5 };
    wrapper = await mountPage();
    const active = wrapper
      .findAll('button')
      .find((b) => b.text().includes('待人工划分'))!;
    expect(active).toBeTruthy();
    expect(active.text()).toContain('待人工划分 5 笔');
    expect(active.attributes('disabled')).toBeUndefined();
    await active.trigger('click');
    expect(pushSpy).toHaveBeenCalledWith(ROUTE_PATH.ADMIN_PENDING_DIVIDENDS);
    wrapper.unmount();

    // pending === 0 → 置灰「暂无待划分」且不隐藏（区分「功能存在但为空」与「没做」）
    pendingSummaryState.data = { pending: 0 };
    wrapper = await mountPage();
    const idle = wrapper
      .findAll('button')
      .find((b) => b.text().includes('暂无待划分'))!;
    expect(idle).toBeTruthy();
    expect(idle.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});
