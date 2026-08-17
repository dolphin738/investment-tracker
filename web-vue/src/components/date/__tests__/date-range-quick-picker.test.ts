/**
 * components/date/DateRangeQuickPicker.vue — 共享日期范围选择器测试
 *
 * 平移自 React 版 web/src/components/date/__tests__/date-range-quick-picker.test.tsx。
 * 拆分两类：
 * 1. resolveQuickRange 纯函数（来自 @/modules/query/quick-range）——直接单测，覆盖
 *    allRangeStart（问题②）/ 回落 2000-01-01 / 非 all 分支不受 allRangeStart 影响。
 * 2. 组件渲染与交互——挂载真实组件（reka-ui Select 在 jsdom 可挂载），校验默认/自定义
 *    label、受控起止日期回显、手动改日期 emit change（quick=undefined）。
 *
 * 时间控制：resolveQuickRange 读 new Date()，用 fake timers 钉死系统时间。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import { resolveQuickRange } from '@/modules/query/quick-range';

const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);
const BASE_DATE = '2024-03-07';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(BASE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DateRangeQuickPicker — 渲染', () => {
  it('渲染快捷范围下拉 + 起止日期输入（默认 label）', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', onChange: () => {} },
    });
    expect(wrapper.text()).toContain('快捷范围');
    expect(wrapper.text()).toContain('开始日期');
    expect(wrapper.text()).toContain('结束日期');
  });

  it('支持自定义截止 label（出入金页用「截止日期」）', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '', endLabel: '截止日期', onChange: () => {} },
    });
    expect(wrapper.text()).toContain('截止日期');
    expect(wrapper.text()).not.toContain('结束日期');
  });

  it('受控：起止日期回显传入值', () => {
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '2026-01-01', endDate: '2026-02-01', onChange: () => {} },
    });
    const inputs = wrapper.findAll('input[type="date"]');
    expect(inputs).toHaveLength(2);
    expect((inputs[0].element as HTMLInputElement).value).toBe('2026-01-01');
    expect((inputs[1].element as HTMLInputElement).value).toBe('2026-02-01');
  });
});

describe('DateRangeQuickPicker — 手动改日期', () => {
  it('改起始日期 → onChange 携带新 startDate，quick 为 undefined', async () => {
    const onChange = vi.fn();
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '', endDate: '2026-06-15', onChange },
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

  it('改结束日期 → onChange 携带新 endDate，保留 startDate', async () => {
    const onChange = vi.fn();
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '2026-01-01', endDate: '', onChange },
    });
    const endInput = wrapper.findAll('input[type="date"]')[1];
    (endInput.element as HTMLInputElement).value = '2026-05-20';
    await endInput.trigger('input');

    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-01-01',
      endDate: '2026-05-20',
      quick: undefined,
    });
  });

  it('清空日期 → 回传空串（= 不限），不抛错', async () => {
    const onChange = vi.fn();
    const wrapper = mount(DateRangeQuickPicker, {
      props: { startDate: '2026-01-01', endDate: '2026-02-01', onChange },
    });
    const startInput = wrapper.findAll('input[type="date"]')[0];
    (startInput.element as HTMLInputElement).value = '';
    await startInput.trigger('input');

    expect(onChange).toHaveBeenCalledWith({
      startDate: '',
      endDate: '2026-02-01',
      quick: undefined,
    });
  });
});

describe('resolveQuickRange — allRangeStart（问题②）', () => {
  it('「全部」起始日 = allRangeStart（组合首个交易日）', () => {
    const r = resolveQuickRange('all', { allRangeStart: BASE_DATE });
    expect(r.startDate).toBe(BASE_DATE);
    expect(r.endDate).toBe('2026-06-15');
  });

  it('未传 allRangeStart → 回落 2000-01-01（单参调用向后兼容）', () => {
    expect(resolveQuickRange('all').startDate).toBe('2000-01-01');
    expect(resolveQuickRange('all', {}).startDate).toBe('2000-01-01');
  });

  it('allRangeStart 为空串 / undefined → 同样回落 2000-01-01（组合尚无首笔买入）', () => {
    expect(resolveQuickRange('all', { allRangeStart: '' }).startDate).toBe('2000-01-01');
    expect(resolveQuickRange('all', { allRangeStart: undefined }).startDate).toBe(
      '2000-01-01',
    );
  });

  it('非 all 分支不受 allRangeStart 影响', () => {
    for (const v of ['1w', '1m', '3m', '6m', '1y', 'ytd']) {
      expect(resolveQuickRange(v, { allRangeStart: BASE_DATE })).toEqual(
        resolveQuickRange(v),
      );
    }
  });
});
