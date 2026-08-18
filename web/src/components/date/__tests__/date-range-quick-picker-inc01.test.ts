/**
 * components/date/DateRangeQuickPicker.vue — INC-01 受控行为与统一文案测试
 *
 * 平移自 React 版 web/src/components/date/__tests__/date-range-quick-picker-inc01.test.tsx。
 * 覆盖：统一起止标签、受控 quick 回显（命中项 / 空串 / 未知值落占位）、
 * 空值=不限、受控模式手动改日期回显回落占位（quick=undefined）。
 *
 * reka-ui Select 在 jsdom 关闭态不回显选中标签，故用原生 <select> 桩替换
 * @/components/ui/select（桶模块 mock，非 .vue 桩），以 select.value 校验受控回显。
 *
 * 时间控制：resolveQuickRange 读 new Date()，用 fake timers 钉死系统时间。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';

// 用原生 <select> 桩替换 reka-ui Select 桶，便于断言受控 quick 回显
vi.mock('@/components/ui/select', async () => {
  const SelectItem = defineComponent({
    name: 'SelectItem',
    props: ['value'],
    setup(props, { slots }) {
      return () => h('option', { value: props.value }, slots.default?.());
    },
  });
  const SelectContent = defineComponent({
    name: 'SelectContent',
    // 透传子节点（不包 div），使 <option> 成为 <select> 的直接子节点
    setup(_, { slots }) {
      return () => (slots.default?.() ?? []);
    },
  });
  const SelectValue = defineComponent({
    name: 'SelectValue',
    props: ['placeholder'],
    setup(props, { slots }) {
      return () => h('span', {}, slots.default?.() ?? props.placeholder);
    },
  });
  const SelectTrigger = defineComponent({
    name: 'SelectTrigger',
    setup(_, { slots }) {
      return () => h('span', {}, slots.default?.());
    },
  });
  const Select = defineComponent({
    name: 'Select',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup(props, { slots, emit }) {
      return () =>
        h(
          'select',
          {
            value: props.modelValue,
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          slots.default?.(),
        );
    },
  });
  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(BASE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function getSelect(wrapper: ReturnType<typeof mount>): HTMLSelectElement {
  const el = wrapper.find('select').element as HTMLSelectElement;
  return el;
}

describe('DateRangeQuickPicker — INC-01 统一起止标签', () => {
  it('默认标签为「开始日期 / 结束日期」', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', onChange: () => {} },
    });
    expect(wrapper.text()).toContain('开始日期');
    expect(wrapper.text()).toContain('结束日期');
  });
});

describe('DateRangeQuickPicker — 受控 quick 回显', () => {
  it('受控 quick="1m" → 快捷下拉选中「近1月」', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', quick: '1m', onChange: () => {} },
    });
    expect(getSelect(wrapper).value).toBe('1m');
  });

  it('受控 quick="" → 下拉落占位（value 空 = 不限）', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', quick: '', onChange: () => {} },
    });
    expect(getSelect(wrapper).value).toBe('');
  });

  it('受控 quick="custom"（未知值）→ 下拉落占位', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', quick: 'custom', onChange: () => {} },
    });
    expect(getSelect(wrapper).value).toBe('');
  });
});

describe('DateRangeQuickPicker — 空值 = 不限', () => {
  it('起止日期为空串 → 输入框值为空', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', onChange: () => {} },
    });
    const inputs = wrapper.findAll('input[type="date"]');
    expect((inputs[0].element as HTMLInputElement).value).toBe('');
    expect((inputs[1].element as HTMLInputElement).value).toBe('');
  });
});

describe('DateRangeQuickPicker — 受控模式手动改日期', () => {
  it('改起始日 → onChange 携带 quick=undefined（回显回落占位）', async () => {
    const onChange = vi.fn();
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '2026-06-15', quick: '1m', onChange },
    });
    const startInput = wrapper.findAll('input[type="date"]')[0];
    (startInput.element as HTMLInputElement).value = '2026-03-01';
    await startInput.trigger('input');

    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-03-01',
      endDate: '2026-06-15',
      quick: undefined,
    });
  });
});
