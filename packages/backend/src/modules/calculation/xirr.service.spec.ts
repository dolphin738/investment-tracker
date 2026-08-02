/**
 * XirrService 适配层测试（calculateXirrForDate + Prisma mock）
 *
 * 【纯函数测试已迁出】
 * 原「Part 1: calculateXirr 纯函数测试」已随算法本体搬到
 * packages/finance-core/src/__tests__/xirr.spec.ts，断言逐条保持不变。
 * 本文件只保留需要 mock PrismaService 的 IO 壳测试：
 * 验证「查询 → buildCashflows（同日合并 + 正终值）→ calculateXirr」这条链路接对了。
 *
 * 预期值计算说明：
 * - XIRR 公式：NPV = sum(CF_i / (1+r)^((d_i - d_0)/365)) = 0
 * - 单次投入 + 单次回收：r = (return/invest)^(365/days) - 1
 * - 精确 365 天：r = return/invest - 1（年化 = 绝对收益）
 */

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
