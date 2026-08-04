/**
 * XIRR 纯函数单元测试
 *
 * 【本文件由 backend/src/modules/calculation/xirr.service.spec.ts 的
 *   「Part 1: calculateXirr 纯函数测试」原样迁出】
 * 断言逐条保持不变，仅把 `service.calculateXirr(...)` 改为直接调用导出的纯函数。
 * 原文件中依赖 Prisma mock 的「Part 2: calculateXirrForDate」留在 backend，
 * 现已改为针对 adapter + buildCashflows 的测试。
 *
 * 预期值计算说明：
 * - XIRR 公式：NPV = sum(CF_i / (1+r)^((d_i - d_0)/365)) = 0
 * - 单次投入 + 单次回收：r = (return/invest)^(365/days) - 1
 * - 精确 365 天：r = return/invest - 1（年化 = 绝对收益）
 */

import { buildCashflows, calculateXirr } from '../index';
import type { Cashflow } from '../index';

// ============================================================
// 辅助函数
// ============================================================

/** 创建 Date 对象（使用 UTC 午夜，避免时区偏移） */
function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z');
}

/** 计算两个日期之间的天数 */
function daysBetween(start: string, end: string): number {
  const ms = d(end).getTime() - d(start).getTime();
  return ms / (24 * 60 * 60 * 1000);
}

/** 根据 NPV 公式验证 rate 是否使 NPV 接近 0（自洽性检查） */
function npvAtRate(cashflows: Cashflow[], rate: number): number {
  const sorted = [...cashflows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const firstDate = sorted[0].date;
  const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
  return sorted.reduce((sum, cf) => {
    const yearFraction = (cf.date.getTime() - firstDate.getTime()) / MS_PER_YEAR;
    return sum + cf.amount / Math.pow(1 + rate, yearFraction);
  }, 0);
}

// ============================================================
// calculateXirr 纯函数测试
// ============================================================

describe('calculateXirr (pure function)', () => {
  // ----------------------------------------------------------
  // 测试 1: 基本收敛 — 半年 5% 收益，年化约 10.28%
  // ----------------------------------------------------------
  it('should converge for basic 2-cashflow scenario (half-year 5% return)', () => {
    // 投入 10000 于 2024-01-01，2024-07-01 收回 10500
    // 2024 是闰年，Jan 1 -> Jul 1 = 182 天
    // XIRR = 1.05^(365/182) - 1
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
      { date: d('2024-07-01'), amount: 10500 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();

    const days = daysBetween('2024-01-01', '2024-07-01');
    const expected = Math.pow(10500 / 10000, 365 / days) - 1;

    // 验证精度 < 1e-4
    expect(Math.abs(result! - expected)).toBeLessThan(1e-4);
    // 大致范围检查
    expect(result).toBeGreaterThan(0.10);
    expect(result).toBeLessThan(0.11);
  });

  // ----------------------------------------------------------
  // 测试 2: 多笔交易混合买卖
  // ----------------------------------------------------------
  it('should handle 3+ mixed buy/sell transactions', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -5000 },
      { date: d('2024-04-01'), amount: -3000 },
      { date: d('2024-07-01'), amount: 4000 },
      { date: d('2024-12-31'), amount: 6000 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();

    // 总投入 8000，总回收 10000，整体盈利 → XIRR 应为正
    expect(result).toBeGreaterThan(0);

    // 自洽性验证：NPV(rate) 应接近 0
    const npv = npvAtRate(cashflows, result!);
    expect(Math.abs(npv)).toBeLessThan(1e-4);
  });

  // ----------------------------------------------------------
  // 测试 3: 全同号返回 null（全为买入负值）
  // ----------------------------------------------------------
  it('should return null when all cashflows are negative (pure buy)', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
      { date: d('2024-06-01'), amount: -5000 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 3b: 全同号返回 null（全为正值）
  // ----------------------------------------------------------
  it('should return null when all cashflows are positive', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: 5000 },
      { date: d('2024-06-01'), amount: 6000 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 4: 单笔交易返回 null
  // ----------------------------------------------------------
  it('should return null for single cashflow', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 5: 零笔交易返回 null
  // ----------------------------------------------------------
  it('should return null for empty cashflows array', () => {
    const cashflows: Cashflow[] = [];

    const result = calculateXirr(cashflows);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 7: 亏损场景 — 终值 < 总投入，XIRR 为负
  // ----------------------------------------------------------
  it('should produce negative XIRR when terminal value < total investment', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
      { date: d('2024-07-01'), amount: 9500 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(0);

    // 自洽性验证
    const npv = npvAtRate(cashflows, result!);
    expect(Math.abs(npv)).toBeLessThan(1e-4);
  });

  // ----------------------------------------------------------
  // 测试 8: 长期投资 — 跨年现金流
  // ----------------------------------------------------------
  it('should handle multi-year cashflows correctly', () => {
    // 2 年投资：2022-01-01 投入 10000，2024-01-01 收回 12100
    // 730 天 = 2 * 365（2022/2023 均非闰年）
    // XIRR = 1.21^(365/730) - 1 = 1.21^0.5 - 1 = 0.10
    const cashflows: Cashflow[] = [
      { date: d('2022-01-01'), amount: -10000 },
      { date: d('2024-01-01'), amount: 12100 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();

    const days = daysBetween('2022-01-01', '2024-01-01');
    const expected = Math.pow(12100 / 10000, 365 / days) - 1;

    expect(Math.abs(result! - expected)).toBeLessThan(1e-4);
    expect(result).toBeCloseTo(0.10, 4);
  });

  // ----------------------------------------------------------
  // 测试 9: 精度验证 — 已知精确答案，误差 < 1e-4
  // ----------------------------------------------------------
  it('should converge with precision < 1e-4 for known exact answer', () => {
    // 精确 365 天（2023 非闰年），投入 1000，收回 1100 → XIRR = 0.10 (10%)
    // 注意：不能用 2024-01-01~2025-01-01，因为 2024 是闰年（366 天）
    const cashflows: Cashflow[] = [
      { date: d('2023-01-01'), amount: -1000 },
      { date: d('2024-01-01'), amount: 1100 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();

    // 精确答案：r = 1100/1000 - 1 = 0.1（365 天 → yearFraction = 1.0）
    expect(Math.abs(result! - 0.1)).toBeLessThan(1e-4);

    // NPV 自洽性
    const npv = npvAtRate(cashflows, result!);
    expect(Math.abs(npv)).toBeLessThan(1e-6);
  });

  // ----------------------------------------------------------
  // 测试 9b: 另一组精度验证 — 20% 年化
  // ----------------------------------------------------------
  it('should converge precisely for 20% annual return over 1 year', () => {
    // 365 天（2023 非闰年），投入 5000，收回 6000 → XIRR = 0.20 (20%)
    const cashflows: Cashflow[] = [
      { date: d('2023-01-01'), amount: -5000 },
      { date: d('2024-01-01'), amount: 6000 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();
    expect(Math.abs(result! - 0.2)).toBeLessThan(1e-4);
  });

  // ----------------------------------------------------------
  // 测试 9c: 精确多笔 — 三笔现金流已知答案
  // ----------------------------------------------------------
  it('should converge for 3-cashflow scenario with self-consistent NPV', () => {
    // 投入 1000 于 2024-01-01，追加 1000 于 2024-04-01，收回 2200 于 2024-12-31
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -1000 },
      { date: d('2024-04-01'), amount: -1000 },
      { date: d('2024-12-31'), amount: 2200 },
    ];

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0); // 整体盈利

    // NPV 自洽性
    const npv = npvAtRate(cashflows, result!);
    expect(Math.abs(npv)).toBeLessThan(1e-4);
  });

  // ----------------------------------------------------------
  // 全部现金流同日 → null（原实现的 allSameDay 分支）
  // ----------------------------------------------------------
  it('should return null when every cashflow falls on the same day', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
      { date: d('2024-01-01'), amount: 10000 },
    ];

    expect(calculateXirr(cashflows)).toBeNull();
  });

  // ----------------------------------------------------------
  // 防御：非法金额（NaN / Infinity）→ 返回 null
  // ----------------------------------------------------------
  it.each([
    { desc: 'amount is NaN', amount: NaN },
    { desc: 'amount is Infinity', amount: Infinity },
    { desc: 'amount is -Infinity', amount: -Infinity },
  ])('should return null when $desc', ({ amount }) => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
      { date: d('2024-07-01'), amount },
    ];

    expect(calculateXirr(cashflows)).toBeNull();
  });
});

// ============================================================
// buildCashflows 纯函数测试
// ============================================================

describe('buildCashflows (pure function)', () => {
  it('should merge same-day transactions into a single net cashflow', () => {
    const cashflows = buildCashflows(
      [
        { date: d('2024-01-01'), type: 'BUY', amount: 5000 },
        { date: d('2024-01-01'), type: 'BUY', amount: 5000 },
      ],
      { date: d('2024-07-01'), totalAsset: 10500 },
    );

    // 同日两笔合并为 -10000，再加上正终值 10500
    expect(cashflows).toHaveLength(2);
    expect(cashflows[0].amount).toBe(-10000);
    expect(cashflows[1]).toEqual({ date: d('2024-07-01'), amount: 10500 });
  });

  it('should net same-day buy and sell against each other', () => {
    const cashflows = buildCashflows(
      [
        { date: d('2024-01-01'), type: 'BUY', amount: 8000 },
        { date: d('2024-01-01'), type: 'SELL', amount: 3000 },
      ],
      { date: d('2024-07-01'), totalAsset: 6000 },
    );

    expect(cashflows).toHaveLength(2);
    expect(cashflows[0].amount).toBe(-5000);
    expect(cashflows[1].amount).toBe(6000);
  });

  it('should keep distinct dates separate and append the terminal value last', () => {
    const cashflows = buildCashflows(
      [
        { date: d('2024-01-01'), type: 'BUY', amount: 5000 },
        { date: d('2024-04-01'), type: 'BUY', amount: 3000 },
        { date: d('2024-07-01'), type: 'SELL', amount: 2000 },
      ],
      { date: d('2024-12-31'), totalAsset: 8000 },
    );

    expect(cashflows).toEqual([
      { date: d('2024-01-01'), amount: -5000 },
      { date: d('2024-04-01'), amount: -3000 },
      { date: d('2024-07-01'), amount: 2000 },
      { date: d('2024-12-31'), amount: 8000 },
    ]);
  });

  it('should accept Prisma Decimal-like values via Number() coercion', () => {
    // Prisma 的 Decimal 是对象；本包不引 @prisma/client，用结构等价替身验证转换语义
    const decimal = (v: string) => ({ toString: () => v });

    const cashflows = buildCashflows(
      [{ date: d('2024-01-01'), type: 'BUY', amount: decimal('10000') }],
      { date: d('2024-07-01'), totalAsset: decimal('10500') },
    );

    expect(cashflows[0].amount).toBe(-10000);
    expect(cashflows[1].amount).toBe(10500);
  });

  it('should produce cashflows that XIRR can solve end-to-end', () => {
    const cashflows = buildCashflows(
      [
        { date: d('2023-01-01'), type: 'BUY', amount: 1000 },
      ],
      { date: d('2024-01-01'), totalAsset: 1100 },
    );

    const result = calculateXirr(cashflows);
    expect(result).not.toBeNull();
    expect(Math.abs(result! - 0.1)).toBeLessThan(1e-4);
  });

  // ----------------------------------------------------------
  // 防御：同日买卖对冲为 0 → 跳过该日零额净现金流
  // ----------------------------------------------------------
  it('should skip same-day buy/sell that net to zero', () => {
    const cashflows = buildCashflows(
      [
        { date: d('2024-01-01'), type: 'BUY', amount: 5000 },
        { date: d('2024-01-01'), type: 'SELL', amount: 5000 },
        { date: d('2024-06-01'), type: 'BUY', amount: 3000 },
      ],
      { date: d('2024-12-31'), totalAsset: 4000 },
    );

    // 1/1 买卖对冲为 0 → 跳过；仅剩 6/1 买入(-3000) + 终值(+4000)
    expect(cashflows).toHaveLength(2);
    expect(cashflows[0]).toEqual({ date: d('2024-06-01'), amount: -3000 });
    expect(cashflows[1]).toEqual({ date: d('2024-12-31'), amount: 4000 });
  });
});
