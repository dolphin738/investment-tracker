/**
 * modules/analysis/__tests__/nav-daily-details.test.ts — computeDailyDetails 纯函数单测
 *
 * §26.3 P3：React 版该逻辑内联在 nav-analysis.tsx 无独立测试；Vue 已抽为
 * nav-daily-details.ts 纯函数，补单测钉死公式：
 * - 每日收益 =（当日累计净值 - 前日累计净值）× 前日份额
 * - 收益百分比 = Δnav / 前日累计净值（与 PRD「每日收益/前一日总资产」数学等价，
 *   Part E-8 / F10）
 * - 按日期升序计算、展示倒序；稀疏日期下「前一日」= 前一个有记录计算日
 */
import { describe, expect, it } from 'vitest';
import { computeDailyDetails } from '../pages/nav-daily-details';
import type { NavSeriesPoint } from '@/lib/types';

function mk(p: Partial<NavSeriesPoint>): NavSeriesPoint {
  return {
    date: '2026-01-01',
    cumulativeNav: 1,
    yearNav: 1,
    shares: 100,
    label: '2026-01-01',
    ...p,
  };
}

describe('computeDailyDetails — 每日净值明细', () => {
  it('空数组 → 空结果', () => {
    expect(computeDailyDetails([])).toEqual([]);
  });

  it('单点数据 → 单行，dailyReturn/returnRate 为 null（无前日）', () => {
    const rows = computeDailyDetails([mk({ date: '2026-01-01' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-01-01');
    expect(rows[0].dailyReturn).toBeNull();
    expect(rows[0].returnRate).toBeNull();
  });

  it('按日期升序计算、展示倒序（乱序输入 → 输出按日期倒序）', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-03', cumulativeNav: 1.3 }),
      mk({ date: '2026-01-01', cumulativeNav: 1 }),
      mk({ date: '2026-01-02', cumulativeNav: 1.1 }),
    ]);
    expect(rows.map((r) => r.date)).toEqual([
      '2026-01-03',
      '2026-01-02',
      '2026-01-01',
    ]);
  });

  it('每日收益 =（当日净值 - 前日净值）× 前日份额', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 1, shares: 1000 }),
      mk({ date: '2026-01-02', cumulativeNav: 1.05, shares: 1000 }),
      mk({ date: '2026-01-03', cumulativeNav: 1.08, shares: 1000 }),
    ]);
    // 倒序：最后一行是 01-02（前日 01-01）
    const r2 = rows.find((r) => r.date === '2026-01-02')!;
    expect(r2.dailyReturn).toBeCloseTo((1.05 - 1) * 1000, 6); // 50
    const r3 = rows.find((r) => r.date === '2026-01-03')!;
    expect(r3.dailyReturn).toBeCloseTo((1.08 - 1.05) * 1000, 6); // 30
  });

  it('收益% = Δnav / 前日净值（数学等价 Part E-8）', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 1 }),
      mk({ date: '2026-01-02', cumulativeNav: 1.05 }),
    ]);
    const r2 = rows.find((r) => r.date === '2026-01-02')!;
    expect(r2.returnRate).toBeCloseTo(0.05, 6); // 0.05/1
  });

  it('首日无前日 → dailyReturn/returnRate 为 null', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 1 }),
      mk({ date: '2026-01-02', cumulativeNav: 1.1 }),
    ]);
    const first = rows.find((r) => r.date === '2026-01-01')!;
    expect(first.dailyReturn).toBeNull();
    expect(first.returnRate).toBeNull();
  });

  it('前日累计净值 = 0 → returnRate 为 null（除零防护），dailyReturn 仍计算', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 0, shares: 500 }),
      mk({ date: '2026-01-02', cumulativeNav: 2, shares: 500 }),
    ]);
    const r2 = rows.find((r) => r.date === '2026-01-02')!;
    expect(r2.dailyReturn).toBeCloseTo((2 - 0) * 500, 6); // 1000
    expect(r2.returnRate).toBeNull();
  });

  it('前日份额为 null / 非有限 → 跳过收益计算（null）', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 1, shares: null }),
      mk({ date: '2026-01-02', cumulativeNav: 1.1, shares: 100 }),
    ]);
    const r2 = rows.find((r) => r.date === '2026-01-02')!;
    expect(r2.dailyReturn).toBeNull();
    expect(r2.returnRate).toBeNull();
  });

  it('当日累计净值 null → 该行收益为 null，且 null 行打断计算链（其后行前日即该 null 行）', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 1 }),
      mk({ date: '2026-01-02', cumulativeNav: null }),
      mk({ date: '2026-01-03', cumulativeNav: 1.2 }),
    ]);
    const r2 = rows.find((r) => r.date === '2026-01-02')!;
    expect(r2.dailyReturn).toBeNull();
    expect(r2.returnRate).toBeNull();
    // 稀疏口径：前日 = 前一个有「记录」的计算日（01-02 有记录但值为 null），
    // 故 01-03 因前日 cumulativeNav=null 无法计算收益（null 行打断计算链）
    const r3 = rows.find((r) => r.date === '2026-01-03')!;
    expect(r3.dailyReturn).toBeNull();
    expect(r3.returnRate).toBeNull();
  });

  it('稀疏日期：前一日 = 前一个有记录计算日（跨空档计算）', () => {
    const rows = computeDailyDetails([
      mk({ date: '2026-01-01', cumulativeNav: 1, shares: 1000 }),
      mk({ date: '2026-01-10', cumulativeNav: 1.3, shares: 1000 }),
    ]);
    const r2 = rows.find((r) => r.date === '2026-01-10')!;
    // 与 01-01 比较（非 01-09，因无 01-02..01-09 记录）
    expect(r2.dailyReturn).toBeCloseTo((1.3 - 1) * 1000, 6);
    expect(r2.returnRate).toBeCloseTo(0.3, 6);
  });

  it('行内保留原始字段（label/yearNav/shares 透传）', () => {
    const rows = computeDailyDetails([
      mk({
        date: '2026-01-01',
        cumulativeNav: 1.1,
        yearNav: 1.02,
        shares: 777,
        label: '2026-01-01',
      }),
    ]);
    expect(rows[0]).toMatchObject({
      date: '2026-01-01',
      cumulativeNav: 1.1,
      yearNav: 1.02,
      shares: 777,
      label: '2026-01-01',
    });
  });

  it('不修改入参数组（排序用副本）', () => {
    const input = [
      mk({ date: '2026-01-03', cumulativeNav: 1.3 }),
      mk({ date: '2026-01-01', cumulativeNav: 1 }),
    ];
    const snapshot = input.map((i) => i.date);
    computeDailyDetails(input);
    expect(input.map((i) => i.date)).toEqual(snapshot);
  });
});
