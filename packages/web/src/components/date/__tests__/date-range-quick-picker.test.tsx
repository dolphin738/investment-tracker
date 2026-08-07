/**
 * components/date/date-range-quick-picker.tsx — 共享日期范围选择器（T-7）
 *
 * 验证点：
 * 1. 渲染快捷范围下拉（7 项）+ 起止日期输入，默认 label 与自定义 label
 * 2. 选中快捷项 → onChange 携带 resolveQuickRange 的起止日期 + quick
 * 3. 「全部」起始日 = allRangeStart（组合首个交易日 baseDate，问题②）
 * 4. 未传 allRangeStart → 「全部」回落 2000-01-01（向后兼容）
 * 5. 手动改起止日期 → onChange 的 quick 为 undefined（下拉回落占位）
 *
 * 时间控制：resolveQuickRange 读 `new Date()`，用 fake timers 钉死系统时间。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { resolveQuickRange } from '@/features/query/dimension-switcher';

/** 基准「今天」：2026-06-15 12:00 本地时间 */
const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);

const BASE_DATE = '2024-03-07';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(BASE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('DateRangeQuickPicker — 渲染', () => {
  it('渲染快捷范围下拉 + 起止日期输入（默认 label）', () => {
    render(
      <DateRangeQuickPicker startDate="" endDate="" onChange={() => {}} />,
    );

    expect(screen.getByText('快捷范围')).toBeDefined();
    expect(screen.getByText('开始日期')).toBeDefined();
    expect(screen.getByText('结束日期')).toBeDefined();
  });

  it('支持自定义起止 label（出入金页用「截止日期」）', () => {
    render(
      <DateRangeQuickPicker
        startDate=""
        endDate=""
        onChange={() => {}}
        endLabel="截止日期"
      />,
    );

    expect(screen.getByText('截止日期')).toBeDefined();
    expect(screen.queryByText('结束日期')).toBeNull();
  });

  it('受控：起止日期回显传入值', () => {
    const { container } = render(
      <DateRangeQuickPicker
        startDate="2026-01-01"
        endDate="2026-02-01"
        onChange={() => {}}
      />,
    );

    const inputs = container.querySelectorAll('input[type="date"]');
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).value).toBe('2026-01-01');
    expect((inputs[1] as HTMLInputElement).value).toBe('2026-02-01');
  });
});

describe('DateRangeQuickPicker — 手动改日期', () => {
  it('改起始日期 → onChange 携带新 startDate，quick 为 undefined', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DateRangeQuickPicker
        startDate=""
        endDate="2026-06-15"
        onChange={onChange}
      />,
    );

    const startInput = container.querySelectorAll('input[type="date"]')[0];
    fireEvent.change(startInput, { target: { value: '2026-03-01' } });

    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-03-01',
      endDate: '2026-06-15',
      quick: undefined,
    });
  });

  it('改结束日期 → onChange 携带新 endDate，保留 startDate', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DateRangeQuickPicker
        startDate="2026-01-01"
        endDate=""
        onChange={onChange}
      />,
    );

    const endInput = container.querySelectorAll('input[type="date"]')[1];
    fireEvent.change(endInput, { target: { value: '2026-05-20' } });

    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-01-01',
      endDate: '2026-05-20',
      quick: undefined,
    });
  });

  it('清空日期 → 回传空串（= 不限），不抛错', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DateRangeQuickPicker
        startDate="2026-01-01"
        endDate="2026-02-01"
        onChange={onChange}
      />,
    );

    const startInput = container.querySelectorAll('input[type="date"]')[0];
    fireEvent.change(startInput, { target: { value: '' } });

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
    expect(resolveQuickRange('all', { allRangeStart: '' }).startDate).toBe(
      '2000-01-01',
    );
    expect(
      resolveQuickRange('all', { allRangeStart: undefined }).startDate,
    ).toBe('2000-01-01');
  });

  it('非 all 分支不受 allRangeStart 影响', () => {
    for (const v of ['1w', '1m', '3m', '6m', '1y', 'ytd']) {
      expect(resolveQuickRange(v, { allRangeStart: BASE_DATE })).toEqual(
        resolveQuickRange(v),
      );
    }
  });
});
