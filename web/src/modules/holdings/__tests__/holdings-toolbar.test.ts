/**
 * modules/holdings/__tests__/holdings-toolbar.test.ts — 统一筛选器组件测试
 *
 * 平移自 React 版 holdings-toolbar.test.tsx 的核心验收点（@vue/test-utils 版本）：
 * 1. 渲染：标题「统一筛选器」+ 口径提示 + as-of / 证券 / 场景控件齐备
 * 2. 快捷范围下拉变更 → change({ range, from:'', to:'' })
 * 3. as-of 单点输入变更 → change({ date })
 * 4. 证券多选切换 → change({ sec })（输入过滤 + checkbox 面板）
 * 5. 场景下拉 → change({ scenario })
 * 6. 持仓专属折叠区：类型多选 + 显示已清仓开关
 *
 * 说明：reka-ui Select 在 jsdom 下无法展开，按既有做法 mock @/components/ui/select
 * 为原生 <select> 替身（对齐 React 版测试同思路）。
 */

import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import HoldingsToolbar from '../components/HoldingsToolbar.vue';
import SecuritySearchCombobox from '@/components/common/SecuritySearchCombobox.vue';
import { SecurityType } from '@/lib/types';
import type { HoldingsFilterState } from '../query-params';
import type { Security } from '@/api/types';

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/api/security-master.api', () => ({
  listSecurityMasters: vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  }),
}));

// reka-ui Select 的原生替身：Select 收集 slot 中的 option 值并转发 update:model-value
vi.mock('@/components/ui/select', async () => {
  await import('vue');

  const Select = defineComponent({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () =>
        h(
          'select',
          {
            value: props.modelValue ?? '',
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          [h('option', { key: '__ph', value: '' }, ''), slots.default?.()],
        );
    },
  });

  const SelectItem = defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      return () => h('option', { value: props.value }, slots.default?.());
    },
  });

  // Content 用 fragment 透传（span 嵌套 option 在 jsdom 的 select.value 中不可靠）
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
    SelectLabel: passthrough,
    SelectSeparator: renderNothing,
    SelectScrollUpButton: renderNothing,
    SelectScrollDownButton: renderNothing,
  };
});

const SECURITIES: Security[] = [
  {
    id: 's-a',
    portfolioId: 'p1',
    name: '甲股票',
    code: '600000',
    type: SecurityType.STOCK,
    note: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 's-b',
    portfolioId: 'p1',
    name: '乙基金',
    code: '000002',
    type: SecurityType.ON_EXCHANGE_FUND,
    note: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const BASE_STATE: HoldingsFilterState = {
  date: '2026-06-15',
  closed: false,
  types: [],
  sec: [],
  scenario: 'all',
  range: '1y',
  from: '',
  to: '',
};

/** 挂载受控工具栏，返回 wrapper 与 change 侦测（onXxx 形式挂事件监听） */
function mountToolbar(overrides: Partial<HoldingsFilterState> = {}) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = mount(HoldingsToolbar, {
    props: {
      value: { ...BASE_STATE, ...overrides },
      minDate: '2024-01-01',
      allRangeStart: '2024-01-01',
      securities: SECURITIES,
      onChange,
    },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return { wrapper, onChange };
}

describe('HoldingsToolbar 统一筛选器', () => {
  it('渲染标题、口径提示与全部维度控件', () => {
    const { wrapper } = mountToolbar();
    const text = wrapper.text();
    expect(text).toContain('统一筛选器');
    expect(text).toContain('持仓板块以持仓日期为准，买卖明细 / 分红费用以日期范围为准');
    expect(text).toContain('持仓日期（as-of）');
    expect(text).toContain('证券');
    expect(text).toContain('场景');
    // 折叠区初始收起，展开按钮存在
    expect(text).toContain('展开持仓选项');
    // as-of 输入受控回显（快捷范围的起止 date input 在前，按回显值精确定位）
    const asOf = wrapper
      .findAll('input[type="date"]')
      .find((i) => (i.element as HTMLInputElement).value === '2026-06-15');
    expect(asOf).toBeDefined();
  });

  it('快捷范围下拉变更 → change({ range, from, to }) 清空自定义起止', async () => {
    const { wrapper, onChange } = mountToolbar();
    // 第一个 select = DateRangeQuickPicker 快捷范围（DOM 顺序先于场景下拉）
    const selects = wrapper.findAll('select');
    await selects[0].setValue('1m');
    expect(onChange).toHaveBeenCalledWith({
      range: '1m',
      from: '',
      to: '',
    });
  });

  it('as-of 日期变更 → change({ date })', async () => {
    const { wrapper, onChange } = mountToolbar();
    const asOf = wrapper
      .findAll('input[type="date"]')
      .find((i) => (i.element as HTMLInputElement).value === '2026-06-15');
    expect(asOf).toBeDefined();
    await asOf!.setValue('2026-05-01');
    expect(onChange).toHaveBeenCalledWith({ date: '2026-05-01' });
  });

  it('证券：主数据搜索选中 → 按 code 映射并加入 sec（多选），标签可移除', async () => {
    const { wrapper, onChange } = mountToolbar();
    const combobox = wrapper.findComponent(SecuritySearchCombobox);
    expect(combobox.exists()).toBe(true);
    // 模拟选中全市场主数据（code=000002，对应组合内已持仓 s-b）
    combobox.vm.$emit('select', { id: 'm-2', code: '000002', name: '乙基金' });
    await nextTick();
    expect(onChange).toHaveBeenCalledWith({ sec: ['s-b'] });
    // 已选项渲染为标签，点击移除按钮 → sec 清空
    // （纯受控组件：emit 后父级回灌 value 才会渲染标签）
    onChange.mockClear();
    await wrapper.setProps({ value: { ...BASE_STATE, sec: ['s-b'] } });
    const removeBtn = wrapper.find('button[aria-label="移除 乙基金"]');
    expect(removeBtn.exists()).toBe(true);
    await removeBtn.trigger('click');
    await nextTick();
    expect(onChange).toHaveBeenCalledWith({ sec: [] });
    // 清空按钮 → change({ sec: [] })
    onChange.mockClear();
    combobox.vm.$emit('clear');
    await nextTick();
    expect(onChange).toHaveBeenCalledWith({ sec: [] });
  });

  it('场景下拉 → change({ scenario })', async () => {
    const { wrapper, onChange } = mountToolbar();
    const selects = wrapper.findAll('select');
    await selects[1].setValue('BUY');
    expect(onChange).toHaveBeenCalledWith({ scenario: 'BUY' });
  });

  it('持仓专属折叠区：类型多选 + 显示已清仓开关', async () => {
    const { wrapper, onChange } = mountToolbar();
    // 展开折叠区
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('展开持仓选项'))!
      .trigger('click');
    await nextTick();
    // 展开类型面板
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('全部类型'))!
      .trigger('click');
    await nextTick();
    // 勾选「股票」类型
    const boxes = wrapper.findAll('input[type="checkbox"]');
    await boxes[0].trigger('change');
    expect(onChange).toHaveBeenCalledWith({ types: [SecurityType.STOCK] });
    // 显示已清仓开关（reka-ui SwitchRoot 在 jsdom 下点击序列不稳定，直接派发组件事件）
    const switchEl = wrapper.find('#holdings-include-closed');
    expect(switchEl.exists()).toBe(true);
    const switchVm = wrapper.findComponent({ name: 'SwitchRoot' });
    switchVm.vm.$emit('update:modelValue', true);
    await nextTick();
    expect(onChange).toHaveBeenCalledWith({ closed: true });
  });
});
