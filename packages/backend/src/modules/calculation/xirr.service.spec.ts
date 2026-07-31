/**
 * XIRR 计算服务单元测试
 *
 * 测试分两部分：
 * 1. calculateXirr — 纯函数测试（不依赖 Prisma，直接 new XirrService(null as any)）
 * 2. calculateXirrForDate — 需要 mock PrismaService（含同日合并逻辑）
 *
 * 预期值计算说明：
 * - XIRR 公式：NPV = sum(CF_i / (1+r)^((d_i - d_0)/365)) = 0
 * - 单次投入 + 单次回收：r = (return/invest)^(365/days) - 1
 * - 精确 365 天：r = return/invest - 1（年化 = 绝对收益）
 */

import { BadRequestException } from '@nestjs/common';
import { XirrService, Cashflow } from './xirr.service';

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
// Part 1: calculateXirr 纯函数测试
// ============================================================

describe('XirrService - calculateXirr (pure function)', () => {
  let service: XirrService;

  beforeAll(() => {
    // calculateXirr 是纯函数，不使用 prisma，可传 null
    service = new XirrService(null as any);
  });

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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 4: 单笔交易返回 null
  // ----------------------------------------------------------
  it('should return null for single cashflow', () => {
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -10000 },
    ];

    const result = service.calculateXirr(cashflows);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 5: 零笔交易返回 null
  // ----------------------------------------------------------
  it('should return null for empty cashflows array', () => {
    const cashflows: Cashflow[] = [];

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
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

    const result = service.calculateXirr(cashflows);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0); // 整体盈利

    // NPV 自洽性
    const npv = npvAtRate(cashflows, result!);
    expect(Math.abs(npv)).toBeLessThan(1e-4);
  });
});

// ============================================================
// Part 2: calculateXirrForDate 测试（需要 mock Prisma）
// ============================================================

describe('XirrService - calculateXirrForDate (with mocked Prisma)', () => {
  let service: XirrService;
  let mockPrisma: any;

  beforeEach(() => {
    // 创建 mock PrismaService
    mockPrisma = {
      transaction: {
        findMany: jest.fn(),
      },
      assetSnapshot: {
        findUnique: jest.fn(),
      },
    };

    service = new XirrService(mockPrisma);
  });

  // ----------------------------------------------------------
  // 测试 6: 同日多笔合并为净现金流
  // ----------------------------------------------------------
  it('should merge same-day transactions into net cashflow', async () => {
    // 同日两笔买入 5000 + 5000 = 10000，终值 10500
    mockPrisma.transaction.findMany.mockResolvedValue([
      { date: d('2024-01-01'), type: 'BUY', amount: { toString: () => '5000' } },
      { date: d('2024-01-01'), type: 'BUY', amount: { toString: () => '5000' } },
    ]);
    mockPrisma.assetSnapshot.findUnique.mockResolvedValue({
      date: d('2024-07-01'),
      totalAsset: { toString: () => '10500' },
    });

    const result = await service.calculateXirrForDate('portfolio-1', d('2024-07-01'));
    expect(result).not.toBeNull();

    // 合并后等效于单笔 -10000 投入 + 10500 收回
    // XIRR = 1.05^(365/182) - 1 ≈ 0.1028
    const days = daysBetween('2024-01-01', '2024-07-01');
    const expected = Math.pow(10500 / 10000, 365 / days) - 1;
    expect(Math.abs(result! - expected)).toBeLessThan(1e-4);

    // 验证 findMany 被调用（确认查询了交易）
    expect(mockPrisma.transaction.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.assetSnapshot.findUnique).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------
  // 测试 6b: 同日买入+卖出合并
  // ----------------------------------------------------------
  it('should merge same-day buy and sell into net cashflow', async () => {
    // 同日买入 8000，卖出 3000 → 净投入 5000
    mockPrisma.transaction.findMany.mockResolvedValue([
      { date: d('2024-01-01'), type: 'BUY', amount: { toString: () => '8000' } },
      { date: d('2024-01-01'), type: 'SELL', amount: { toString: () => '3000' } },
    ]);
    mockPrisma.assetSnapshot.findUnique.mockResolvedValue({
      date: d('2024-07-01'),
      totalAsset: { toString: () => '6000' },
    });

    const result = await service.calculateXirrForDate('portfolio-1', d('2024-07-01'));
    expect(result).not.toBeNull();

    // 净投入 5000（-8000 + 3000 = -5000），终值 6000
    // XIRR = 1.2^(365/182) - 1
    const days = daysBetween('2024-01-01', '2024-07-01');
    const expected = Math.pow(6000 / 5000, 365 / days) - 1;
    expect(Math.abs(result! - expected)).toBeLessThan(1e-4);
  });

  // ----------------------------------------------------------
  // 测试: 无快照返回 null
  // ----------------------------------------------------------
  it('should return null when no snapshot exists for the date', async () => {
    mockPrisma.transaction.findMany.mockResolvedValue([]);
    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(null);

    const result = await service.calculateXirrForDate('portfolio-1', d('2024-07-01'));
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试: 多日交易 + 终值
  // ----------------------------------------------------------
  it('should build correct cashflows from multi-date transactions + terminal value', async () => {
    mockPrisma.transaction.findMany.mockResolvedValue([
      { date: d('2024-01-01'), type: 'BUY', amount: { toString: () => '5000' } },
      { date: d('2024-04-01'), type: 'BUY', amount: { toString: () => '3000' } },
      { date: d('2024-07-01'), type: 'SELL', amount: { toString: () => '2000' } },
    ]);
    mockPrisma.assetSnapshot.findUnique.mockResolvedValue({
      date: d('2024-12-31'),
      totalAsset: { toString: () => '8000' },
    });

    const result = await service.calculateXirrForDate('portfolio-1', d('2024-12-31'));
    expect(result).not.toBeNull();
    // 总投入 8000，总回收 10000（卖 2000 + 终值 8000），整体盈利
    expect(result!).toBeGreaterThan(0);

    // NPV 自洽性
    const cashflows: Cashflow[] = [
      { date: d('2024-01-01'), amount: -5000 },
      { date: d('2024-04-01'), amount: -3000 },
      { date: d('2024-07-01'), amount: 2000 },
      { date: d('2024-12-31'), amount: 8000 },
    ];
    const npv = npvAtRate(cashflows, result!);
    expect(Math.abs(npv)).toBeLessThan(1e-4);
  });
});
