/**
 * modules/admin/__tests__/global-settings-dividend-tab.test.ts — 全局设置页测试
 *
 * 覆盖（对齐方案 §10.4/§15.3 + 迁移 0022）：
 * 1. 顶层 TAB 顺序： [初始化][股息率]，默认激活「初始化」
 * 2. 「初始化」TAB 含「回补复权方式」下拉（不复权/前复权/后复权）且与「回补模式」并排
 * 3. 保存 payload 带 price_backfill_adjust（配置真正参与 PUT）
 * 4. 「股息率」TAB 四源下拉选项过滤与「接口名（提供方名）」拼接
 * 5. 切换 TAB 不丢表单值（页面持有唯一一份 settingsForm）
 * 6. 每日回补额度越界拦截、在途/额度用尽/失败状态文案与按钮护栏（自旧 InitBlock 用例平移）
 *
 * Mock 策略：composables 层（useDividendYieldSettings / useDividendYieldInterfaces /
 * useUpdateDividendYieldSettings / useQuoteProviders）全部 mock；@/stores/auth.store 的
 * useIsAdmin 恒 true；reka-ui Select / Tabs 以轻量替身（原生 <select>/<option>、
 * provide/inject 驱动的按钮）渲染，便于断言与切换 TAB。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';
import type { DividendYieldSettingsOut } from '@/api/types';

// ---------------------------------------------------------------------------
// 测试数据（模块级共享：mock 工厂与断言共用）
// ---------------------------------------------------------------------------

const interfaces = vi.hoisted(() => [
  { id: 'i1', provider_id: 'p1', category_id: '3', name: '东财-分红配送', enabled: true },
  { id: 'i2', provider_id: 'p2', category_id: '3', name: '新浪-分红配股', enabled: true },
  { id: 'i3', provider_id: 'p1', category_id: '2', name: '腾讯财经-A股行情', enabled: true },
  { id: 'i4', provider_id: 'p1', category_id: '4', name: '沪深京A股公告', enabled: true },
  // 分类 4 但未启用：不应出现在公告源下拉
  { id: 'i5', provider_id: 'p2', category_id: '4', name: '东财-公告扫描', enabled: false },
]);

const providers = vi.hoisted(() => [
  { id: 'p1', name: '东方财富' },
  { id: 'p2', name: '新浪财经' },
]);

const settings = vi.hoisted<DividendYieldSettingsOut>(() => ({
  green_threshold: 0.05,
  red_threshold: 0.03,
  dividend_report_source: { id: 'i1', name: '东财-分红配送' },
  dividend_detail_source: { id: 'i2', name: '新浪-分红配股' },
  price_source: { id: 'i3', name: '腾讯财经-A股行情' },
  announcement_source: null,
  price_backfill_source: null,
  // 在途回补任务目标起始日（YYYY-MM-DD）；null = 无在途任务
  price_backfill_start_date: null,
  // 回补起始日期配置默认值（YYYY-MM-DD）；null = 未设置（前端回退一年前）
  price_backfill_default_start_date: null,
  // 每日回补额度（只/天）；后端默认 1000
  price_backfill_quota: null,
  // 当日已用额度（只）；后端回传当日有效值（跨日已归零）
  price_backfill_used_today: 0,
  // 最近一次回补失败原因（熔断/接口不可达）；null = 无失败/已清空
  price_backfill_last_error: null,
  // 交易日历刷新起始日期；null = 未配置（后端默认去年 1 月 1 日）
  trade_calendar_start_date: null,
  price_backfill_mode: 'legacy',
  // 回补复权方式：''（不复权，默认）| 'qfq' | 'hfq'
  price_backfill_adjust: '',
}));

const mutateSpy = vi.hoisted(() => vi.fn());
const cancelPriceBackfillSpy = vi.hoisted(() => vi.fn());

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
  useBackfillSpecialDividends: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: vi.fn(),
  }),
  useBackfillDividendPrices: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: vi.fn(),
  }),
  useCancelPriceBackfill: () => ({
    isPending: ref(false),
    isError: ref(false),
    mutate: cancelPriceBackfillSpy,
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

// reka-ui Select 原生替身：Select 渲染为 <select>，SelectItem 渲染为 <option>（可断言文本）。
// 关键：把子节点 SelectTrigger 上的 id 转接到替身 <select> 的 id，使测试可按
// #dy-backfill-mode / #dy-report-source 等稳定锚点定位，不再依赖 DOM 顺序。
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

/** 股息率 TAB 的四个接口下拉（稳定锚点，id 由 SelectTrigger 提供、替身 <select> 转接） */
const DIVIDEND_INTERFACE_SELECT_IDS = [
  'dy-report-source',
  'dy-detail-source',
  'dy-price-source',
  'dy-announcement-source',
] as const;

/** 初始化 TAB 的接口下拉（历史行情回补接口） */
const INIT_INTERFACE_SELECT_IDS = ['dy-price-backfill-source'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  // 隔离在途状态 / 额度字段，避免污染其他用例（共享 hoisted settings 对象可变）
  settings.price_backfill_start_date = null;
  settings.price_backfill_quota = null;
  settings.price_backfill_used_today = 0;
  settings.price_backfill_last_error = null;
  settings.price_backfill_adjust = '';
});

describe('GlobalSettingsPage — 顶层 TAB 与全局设置', () => {
  it('① 「初始化」是第一个 TAB 且默认激活', async () => {
    wrapper = await mountPage();

    // TAB 顺序：[初始化][股息率]
    const tabs = wrapper.findAll('[data-tab]');
    expect(tabs.map((t) => t.text())).toEqual(['初始化', '股息率']);
    expect(tabs[0].attributes('data-tab')).toBe('init');

    // 默认激活「初始化」：其内容可见，股息率内容不可见
    expect(wrapper.text()).toContain('回补复权方式');
    expect(wrapper.find('#dy-report-source').exists()).toBe(false);

    wrapper.unmount();
  });

  it('② 初始化 TAB：回补复权方式三项（不复权/前复权/后复权）且与「回补模式」并排', async () => {
    wrapper = await mountPage();

    const adjustSelect = wrapper.find('#dy-backfill-adjust');
    expect(adjustSelect.exists()).toBe(true);
    // 选项值：不复权用哨兵（reka-ui 禁止 value=""），前复权 qfq、后复权 hfq
    expect(
      realOptions(adjustSelect).map((o) => o.attributes('value')),
    ).toEqual([SELECT_EMPTY_VALUE, 'qfq', 'hfq']);
    expect(realOptions(adjustSelect).map((o) => o.text())).toEqual([
      '不复权（默认）',
      '前复权',
      '后复权',
    ]);

    // 与「回补模式」并排：落在同一 2 列网格、且不再是整行（无 sm:col-span-2）
    const modeSelect = wrapper.find('#dy-backfill-mode');
    expect(modeSelect.exists()).toBe(true);
    const modeGrid = modeSelect.element.closest('.grid');
    const adjustGrid = adjustSelect.element.closest('.grid');
    expect(modeGrid).not.toBeNull();
    expect(modeGrid).toBe(adjustGrid);
    expect(modeGrid!.className).toContain('sm:grid-cols-2');
    expect(
      modeSelect.element.closest('.space-y-2')!.className,
    ).not.toContain('sm:col-span-2');

    // 初始化 TAB 的「历史行情回补接口」下拉：含「不设置」哨兵项、无空串 value
    INIT_INTERFACE_SELECT_IDS.forEach((id) => {
      const sel = wrapper.find(`#${id}`);
      expect(sel.exists()).toBe(true);
      expect(
        realOptions(sel).some((o) => o.attributes('value') === SELECT_EMPTY_VALUE),
      ).toBe(true);
      expect(realOptions(sel).some((o) => o.attributes('value') === '')).toBe(false);
    });

    wrapper.unmount();
  });

  it('③ 保存 payload 带 price_backfill_adjust（配置参与 PUT）', async () => {
    wrapper = await mountPage();

    // 把复权方式切到 hfq（后复权）
    const adjustSelect = wrapper.find('#dy-backfill-adjust');
    await adjustSelect.setValue('hfq');
    await flushPromises();

    const saveBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('保存设置'))!;
    expect(saveBtn.attributes('disabled')).toBeUndefined(); // 有变更 → 可保存
    await saveBtn.trigger('click');
    await flushPromises();

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const payload = mutateSpy.mock.calls[0][0];
    expect(payload.price_backfill_adjust).toBe('hfq');
    // 保存是全字段 PUT：带四源与回补字段（阈值已迁「个人中心 → 偏好设置」，不再出现在本 payload）
    expect(payload).not.toHaveProperty('green_threshold');
    expect(payload).toHaveProperty('price_backfill_mode');

    wrapper.unmount();
  });

  it('④ 股息率 TAB：四源下拉过滤 + 「接口名（提供方名）」拼接', async () => {
    wrapper = await mountPage();
    await switchTab(wrapper, 'dividend');

    // 页面含「公司公告接口」区块
    expect(wrapper.text()).toContain('公司公告接口');
    // 「回补模式 / 复权方式」属初始化 TAB，切走后不在 DOM
    expect(wrapper.find('#dy-backfill-mode').exists()).toBe(false);

    // 公告源下拉（按 id 锚定）：仅含启用的分类 4 接口
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
      interfaceOptions(wrapper.find('#dy-report-source'))[0].text(),
    ).toBe('东财-分红配送（东方财富）');
    expect(
      interfaceOptions(wrapper.find('#dy-detail-source'))[1].text(),
    ).toBe('新浪-分红配股（新浪财经）');
    expect(
      interfaceOptions(wrapper.find('#dy-announcement-source'))[0].text(),
    ).toBe('沪深京A股公告（东方财富）');

    wrapper.unmount();
  });

  it('⑤ 切换 TAB 不丢表单值（页面持有唯一一份 settingsForm）', async () => {
    wrapper = await mountPage();

    // 初始化 TAB：把复权方式改为 qfq
    await wrapper.find('#dy-backfill-adjust').setValue('qfq');
    await flushPromises();

    // 切到股息率再切回初始化，值仍在
    await switchTab(wrapper, 'dividend');
    await switchTab(wrapper, 'init');
    expect(
      (wrapper.find('#dy-backfill-adjust').element as HTMLSelectElement).value,
    ).toBe('qfq');

    wrapper.unmount();
  });

  it('⑥ 每日回补额度越界（2001）点击保存不调用 update 且显示中文错误', async () => {
    wrapper = await mountPage();

    const quotaInput = wrapper.find('input#dy-price-backfill-quota');
    expect(quotaInput.exists()).toBe(true);
    await quotaInput.setValue('2001');
    await flushPromises();

    const saveBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('保存设置'))!;
    await saveBtn.trigger('click');
    await flushPromises();

    expect(mutateSpy).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('每日回补额度须为 1 到 2000 之间的整数');

    wrapper.unmount();
  });

  it('⑦ 在途任务：展示进行中文案 + 触发按钮置灰 + 出现「取消在途回补」', async () => {
    settings.price_backfill_start_date = '2025-07-01';
    wrapper = await mountPage();

    const text = wrapper.text();
    expect(text).toContain('回补进行中');
    expect(text).toContain('2025-07-01');
    expect(text).toContain('每日收盘价抓取后按额度自动续跑');

    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('回补进行中'));
    expect(btn).toBeTruthy();
    expect(btn!.attributes('disabled')).toBeDefined();
    expect(btn!.attributes('title') ?? '').toContain('已有在途回补任务');

    const cancelBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('取消在途回补'));
    expect(cancelBtn).toBeTruthy();

    wrapper.unmount();
  });

  it('⑧ 「取消在途回补」需二次确认后才触发', async () => {
    settings.price_backfill_start_date = '2025-07-01';
    wrapper = await mountPage();

    const cancelBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('取消在途回补'));
    await cancelBtn!.trigger('click');
    await flushPromises();

    const dialog = Array.from(
      document.querySelectorAll('[role="alertdialog"]'),
    ).find((el) => (el.textContent ?? '').includes('确认取消在途回补？'));
    expect(dialog).toBeTruthy();
    const confirmBtn = Array.from(dialog!.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('确认取消'),
    );
    expect(confirmBtn).toBeTruthy();
    expect(cancelPriceBackfillSpy).not.toHaveBeenCalled();

    await confirmBtn!.click();
    await flushPromises();
    expect(cancelPriceBackfillSpy).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it('⑨ 当日额度用尽 → 触发按钮置灰显示「今日额度已用尽」并展示已用/总额', async () => {
    settings.price_backfill_used_today = 1000;
    wrapper = await mountPage();

    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('今日额度已用尽'));
    expect(btn).toBeTruthy();
    expect(btn!.attributes('disabled')).toBeDefined();
    expect(btn!.attributes('title') ?? '').toContain('额度已用尽');
    expect(wrapper.text()).toContain('今日已用 1000 / 1000');

    wrapper.unmount();
  });

  it('⑩ price_backfill_last_error 非空时渲染「回补失败」红字原因；为空时不渲染', async () => {
    wrapper = await mountPage();
    expect(wrapper.text()).not.toContain('回补失败');
    wrapper.unmount();

    settings.price_backfill_last_error = '回补连续失败熔断：连续失败 3 只（阈值 3）';
    wrapper = await mountPage();

    const text = wrapper.text();
    expect(text).toContain('回补失败');
    expect(text).toContain('回补连续失败熔断');
    const failLine = wrapper.findAll('p').find((el) => el.text().includes('回补失败'));
    expect(failLine).toBeTruthy();
    expect(failLine!.classes()).toContain('text-red-600');

    wrapper.unmount();
  });
});
