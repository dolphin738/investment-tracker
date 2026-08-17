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
import HoldingsToolbar from '../components/HoldingsToolbar.vue';
import { SecurityType } from '@/lib/types';
import type { HoldingsFilterState } from '../query-params';
import type { Security } from '@/api/types';

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
  const wrapper = mount(HoldingsToolbar, {
    props: {
      value: { ...BASE_STATE, ...overrides },
      minDate: '2024-01-01',
      allRangeStart: '2024-01-01',
      securities: SECURITIES,
      onChange,
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

  it('证券多选：输入过滤 + 勾选 → change({ sec })', async () => {
    const { wrapper, onChange } = mountToolbar();
    // 证券搜索框（text 输入，位于 as-of 之后）
    const search = wrapper.find('input[type="text"]');
    await search.setValue('乙');
    await nextTick();
    // 过滤后面板仅显示乙基金
    const panel = wrapper.find('[data-testid="holdings-unified-filter"]');
    expect(panel.text()).toContain('乙基金');
    expect(panel.text()).not.toContain('甲股票');
    // 勾选乙基金
    const box = wrapper.find('input[type="checkbox"]');
    expect((box.element as HTMLInputElement).value).toBe('on');
    await box.trigger('change');
    expect(onChange).toHaveBeenCalledWith({ sec: ['s-b'] });
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
