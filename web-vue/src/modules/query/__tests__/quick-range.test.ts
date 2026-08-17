/**
 * modules/query/quick-range.ts — 快捷日期范围口径单测（移植自 React 版）
 *
 * 验证点（对齐决策 Q-6 乙）：
 * 1. QUICK_RANGE_OPTIONS 恰为 7 项，顺序与文案锁定
 * 2. resolveQuickRange 对 1w/1m/3m/6m/1y/ytd/all 七个分支起止日期正确
 * 3. 未知值回落「近1年」
 * 4. 返回类型收窄：startDate/endDate 恒为非空字符串
 * 5. 边界日期不变式：任一预设都满足 startDate <= endDate
 *
 * 时间控制：resolveQuickRange 读 new Date()，用 fake timers 钉死系统时间。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUICK_RANGE_OPTIONS,
  resolveQuickRange,
} from '@/modules/query/quick-range';

/** 基准「今天」：2026-06-15 12:00 本地时间 */
const BASE_NOW = new Date(2026, 5, 15, 12, 0, 0);

describe('QUICK_RANGE_OPTIONS — 7 项快捷范围（决策 Q-6 乙）', () => {
  it('恰为 7 项，且 value 顺序锁定', () => {
    expect(QUICK_RANGE_OPTIONS).toHaveLength(7);
    expect(QUICK_RANGE_OPTIONS.map((o) => o.value)).toEqual([
      '1w',
      '1m',
      '3m',
      '6m',
      '1y',
      'ytd',
      'all',
    ]);
  });

  it('文案锁定：新增「近一周」「近6月」，ytd 由「今年至今」改为「今年」', () => {
    expect(QUICK_RANGE_OPTIONS.map((o) => o.label)).toEqual([
      '近一周',
      '近1月',
      '近3月',
      '近6月',
      '近1年',
      '今年',
      '全部',
    ]);
    expect(QUICK_RANGE_OPTIONS.some((o) => o.label === '今年至今')).toBe(false);
  });

  it('value 唯一，无重复项', () => {
    const values = QUICK_RANGE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('resolveQuickRange — 七分支起止日期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['1w', '2026-06-08', '近一周 = 今天 - 7 天'],
    ['1m', '2026-05-15', '近1月 = 今天 - 1 个月'],
    ['3m', '2026-03-15', '近3月 = 今天 - 3 个月'],
    ['6m', '2025-12-15', '近6月 = 今天 - 6 个月（跨年）'],
    ['1y', '2025-06-15', '近1年 = 今天 - 1 年'],
    ['ytd', '2026-01-01', '今年 = 当年 1 月 1 日'],
    ['all', '2000-01-01', '全部 = 固定 2000-01-01'],
  ])('%s → startDate %s（%s）', (range, expectedStart) => {
    const result = resolveQuickRange(range as string);
    expect(result.startDate).toBe(expectedStart);
    expect(result.endDate).toBe('2026-06-15');
  });

  it('未知值回落「近1年」（default 分支）', () => {
    const fallback = resolveQuickRange('__unknown__');
    expect(fallback).toEqual(resolveQuickRange('1y'));
    expect(fallback.startDate).toBe('2025-06-15');
  });

  it('空字符串同样回落「近1年」，不返回空对象', () => {
    expect(resolveQuickRange('')).toEqual({
      startDate: '2025-06-15',
      endDate: '2026-06-15',
    });
  });

  it('返回类型收窄：所有预设的 startDate/endDate 均为非空字符串', () => {
    for (const opt of QUICK_RANGE_OPTIONS) {
      const r = resolveQuickRange(opt.value);
      expect(typeof r.startDate).toBe('string');
      expect(typeof r.endDate).toBe('string');
      expect(r.startDate).not.toBe('');
      expect(r.endDate).not.toBe('');
      expect(r.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('resolveQuickRange — 边界日期不变式', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const EDGE_DATES = [
    new Date(2026, 0, 31, 12, 0, 0), // 2026-01-31 月末
    new Date(2026, 2, 31, 12, 0, 0), // 2026-03-31 月末（回绕高发）
    new Date(2026, 7, 31, 12, 0, 0), // 2026-08-31 月末
    new Date(2024, 1, 29, 12, 0, 0), // 2024-02-29 闰日
    new Date(2026, 11, 31, 12, 0, 0), // 2026-12-31 年末
  ];

  function ymd(d: Date): string {
    const yyyy = d.getFullYear().toString();
    const MM = (d.getMonth() + 1).toString().padStart(2, '0');
    const dd = d.getDate().toString().padStart(2, '0');
    return `${yyyy}-${MM}-${dd}`;
  }

  it.each(EDGE_DATES.map((d) => [ymd(d), d] as const))(
    '基准日 %s：7 个预设均满足 startDate <= endDate',
    (_label, now) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);

      for (const opt of QUICK_RANGE_OPTIONS) {
        const r = resolveQuickRange(opt.value);
        expect(r.startDate <= r.endDate, `${opt.value}: ${r.startDate} > ${r.endDate}`).toBe(
          true,
        );
        expect(r.endDate).toBe(ymd(now));
      }
    },
  );

  it('已知边界：月末 setMonth 回绕会使窗口略短于自然月，但仍合法', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 31, 12, 0, 0));
    const r = resolveQuickRange('1m');
    expect(r.startDate).toBe('2026-03-03');
    expect(r.startDate <= r.endDate).toBe(true);
  });
});
