/**
 * 净值计算服务单元测试
 *
 * 测试 NavService.calculateNavForDate（份额法净值计算）。
 * 通过 mock PrismaService 隔离数据库依赖。
 *
 * 测试覆盖：
 * 1. 成立日：首笔买入 → nav=1.0, shares=buyAmount, base=1.0
 * 2. 非成立日（无交易）：nav=asset/prevShares, shares 不变
 * 3. 非成立日（有买入）：新增份额=buyAmount/nav
 * 4. 非成立日（有卖出）：赎回份额=sellAmount/nav
 * 5. 当年首日（跨年）：base=prevCumNav, yearNav=1.0
 * 6. 当年非首日：yearNav=cumNav/base
 * 7. 无快照返回 null
 * 8. 成立日无买入抛 BadRequestException
 */

import { BadRequestException } from '@nestjs/common';
import { NavService } from './nav.service';

// ============================================================
// 辅助函数
// ============================================================

/** 创建 Date 对象（使用 UTC 午夜，避免时区偏移） */
function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z');
}

/** 创建 mock PrismaService */
function createMockPrisma() {
  return {
    assetSnapshot: {
      findUnique: jest.fn(),
    },
    dailyNav: {
      findFirst: jest.fn(),
    },
    transaction: {
      findMany: jest.fn(),
    },
  };
}

/**
 * 创建模拟的 DailyNav 记录
 * Prisma Decimal 字段用 number 模拟（Number() 可直接转换）
 */
function makePrevNav(opts: {
  date: Date;
  shares: number;
  cumulativeNav: number;
  baseCumulativeNav: number | null;
}) {
  return {
    date: opts.date,
    shares: opts.shares,
    cumulativeNav: opts.cumulativeNav,
    baseCumulativeNav: opts.baseCumulativeNav,
  };
}

/** 创建模拟的交易记录 */
function makeTx(type: 'BUY' | 'SELL', amount: number, date: Date) {
  return { type, amount, date };
}

/** 创建模拟的资产快照 */
function makeSnapshot(totalAsset: number, date: Date) {
  return { totalAsset, date };
}

// ============================================================
// 测试
// ============================================================

describe('NavService - calculateNavForDate', () => {
  let service: NavService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new NavService(mockPrisma);
  });

  // ----------------------------------------------------------
  // 测试 1: 成立日 — 首笔买入 10000
  // ----------------------------------------------------------
  it('should return nav=1.0, shares=buyAmount on inception day', async () => {
    const date = d('2024-01-01');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(10000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(null); // 无前日净值 → 成立日
    mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 10000, date)]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBe(1.0);
    expect(result!.cumulativeNav).toBe(1.0);
    expect(result!.yearNav).toBe(1.0);
    expect(result!.shares).toBe(10000);
    expect(result!.baseCumulativeNav).toBe(1.0);
  });

  // ----------------------------------------------------------
  // 测试 1b: 成立日 — 多笔买入合并
  // ----------------------------------------------------------
  it('should sum multiple buy amounts on inception day', async () => {
    const date = d('2024-01-01');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(15000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(null);
    mockPrisma.transaction.findMany.mockResolvedValue([
      makeTx('BUY', 10000, date),
      makeTx('BUY', 5000, date),
    ]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBe(1.0);
    expect(result!.shares).toBe(15000); // 10000 + 5000
  });

  // ----------------------------------------------------------
  // 测试 2: 非成立日（无交易）— 资产 11000, 上日份额 10000
  // ----------------------------------------------------------
  it('should calculate nav = asset/prevShares on non-inception day without transactions', async () => {
    const date = d('2024-01-02');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(11000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-01-01'),
        shares: 10000,
        cumulativeNav: 1.0,
        baseCumulativeNav: 1.0,
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(1.1, 6); // 11000/10000
    expect(result!.cumulativeNav).toBeCloseTo(1.1, 6);
    expect(result!.shares).toBe(10000); // 无交易，份额不变
    // 同年非首日 → yearNav = cumNav/base = 1.1/1.0 = 1.1
    expect(result!.yearNav).toBeCloseTo(1.1, 6);
    expect(result!.baseCumulativeNav).toBe(1.0);
  });

  // ----------------------------------------------------------
  // 测试 3: 非成立日（有买入）— 资产 12000, 上日份额 10000, 买入 6000
  // ----------------------------------------------------------
  it('should add new shares = buyAmount/unitNav on non-inception day with buy', async () => {
    const date = d('2024-01-02');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(12000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-01-01'),
        shares: 10000,
        cumulativeNav: 1.0,
        baseCumulativeNav: 1.0,
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 6000, date)]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(1.2, 6); // 12000/10000
    // 新增份额 = 6000/1.2 = 5000
    expect(result!.shares).toBeCloseTo(15000, 4); // 10000 + 5000
    expect(result!.cumulativeNav).toBeCloseTo(1.2, 6);
    expect(result!.yearNav).toBeCloseTo(1.2, 6); // 1.2/1.0
  });

  // ----------------------------------------------------------
  // 测试 4: 非成立日（有卖出）— 资产 9000, 上日份额 10000, 卖出 900
  // ----------------------------------------------------------
  it('should redeem shares = sellAmount/unitNav on non-inception day with sell', async () => {
    const date = d('2024-01-02');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(9000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-01-01'),
        shares: 10000,
        cumulativeNav: 1.0,
        baseCumulativeNav: 1.0,
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([makeTx('SELL', 900, date)]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(0.9, 6); // 9000/10000
    // 赎回份额 = 900/0.9 = 1000
    expect(result!.shares).toBeCloseTo(9000, 4); // 10000 - 1000
    expect(result!.cumulativeNav).toBeCloseTo(0.9, 6);
    expect(result!.yearNav).toBeCloseTo(0.9, 6); // 0.9/1.0
  });

  // ----------------------------------------------------------
  // 测试 4b: 非成立日（同时有买入和卖出）
  // ----------------------------------------------------------
  it('should handle both buy and sell on same day', async () => {
    const date = d('2024-01-02');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(12000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-01-01'),
        shares: 10000,
        cumulativeNav: 1.0,
        baseCumulativeNav: 1.0,
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([
      makeTx('BUY', 6000, date),
      makeTx('SELL', 1200, date),
    ]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(1.2, 6); // 12000/10000
    // 新增份额 = 6000/1.2 = 5000, 赎回份额 = 1200/1.2 = 1000
    expect(result!.shares).toBeCloseTo(14000, 4); // 10000 + 5000 - 1000
  });

  // ----------------------------------------------------------
  // 测试 5: 当年首日（跨年）— base=prevCumNav, yearNav=1.0
  // ----------------------------------------------------------
  it('should reset yearNav=1.0 and set base=prevCumNav on year-first trading day', async () => {
    const date = d('2025-01-02'); // 2025 年首个交易日

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(16000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-12-31'), // 上年末最后一个交易日
        shares: 10000,
        cumulativeNav: 1.5, // 上年末累计净值
        baseCumulativeNav: 1.2,
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(1.6, 6); // 16000/10000
    expect(result!.cumulativeNav).toBeCloseTo(1.6, 6);
    // 跨年 → yearNav 重置为 1.0
    expect(result!.yearNav).toBe(1.0);
    // base = 上年末累计净值 = 1.5
    expect(result!.baseCumulativeNav).toBeCloseTo(1.5, 6);
  });

  // ----------------------------------------------------------
  // 测试 6: 当年非首日 — yearNav = cumNav/base
  // ----------------------------------------------------------
  it('should calculate yearNav = cumNav/base on non-first day of year', async () => {
    const date = d('2025-01-03'); // 2025 年第二个交易日

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(17000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2025-01-02'), // 同年，当年首日
        shares: 10000,
        cumulativeNav: 1.6,
        baseCumulativeNav: 1.5, // 当年基准
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(1.7, 6); // 17000/10000
    expect(result!.cumulativeNav).toBeCloseTo(1.7, 6);
    // 当年非首日 → yearNav = cumNav/base = 1.7/1.5
    expect(result!.yearNav).toBeCloseTo(1.7 / 1.5, 6);
    // base 继承自前日
    expect(result!.baseCumulativeNav).toBeCloseTo(1.5, 6);
  });

  // ----------------------------------------------------------
  // 测试 7: 无快照返回 null
  // ----------------------------------------------------------
  it('should return null when no snapshot exists for the date', async () => {
    const date = d('2024-01-15');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(null);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).toBeNull();
    // 无快照时不应查询 dailyNav 和 transactions
    expect(mockPrisma.dailyNav.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.transaction.findMany).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // 测试 8: 成立日无买入抛 BadRequestException
  // ----------------------------------------------------------
  it('should throw BadRequestException on inception day without buy transaction', async () => {
    const date = d('2024-01-01');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(5000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(null); // 无前日 → 成立日
    mockPrisma.transaction.findMany.mockResolvedValue([
      makeTx('SELL', 5000, date), // 只有卖出，无买入
    ]);

    await expect(
      service.calculateNavForDate('portfolio-1', date),
    ).rejects.toThrow(BadRequestException);
  });

  // ----------------------------------------------------------
  // 测试 8b: 成立日完全无交易抛 BadRequestException
  // ----------------------------------------------------------
  it('should throw BadRequestException on inception day with no transactions', async () => {
    const date = d('2024-01-01');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(5000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(null);
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    await expect(
      service.calculateNavForDate('portfolio-1', date),
    ).rejects.toThrow(BadRequestException);
  });

  // ----------------------------------------------------------
  // 测试 9: 上日份额 <= 0 返回 null（防护性边界）
  // ----------------------------------------------------------
  it('should return null when prevShares <= 0', async () => {
    const date = d('2024-01-02');

    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(10000, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-01-01'),
        shares: 0, // 异常：份额为 0
        cumulativeNav: 1.0,
        baseCumulativeNav: 1.0,
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const result = await service.calculateNavForDate('portfolio-1', date);
    expect(result).toBeNull();
  });

  // ----------------------------------------------------------
  // 测试 10: 完整跨年场景 — 验证年度净值连续性
  // ----------------------------------------------------------
  it('should maintain yearNav continuity across year boundary', async () => {
    // 场景：
    // 2024-01-01: 成立日，买入 10000，nav=1.0
    // 2024-12-31: 资产 15000，nav=1.5（上年末累计净值）
    // 2025-01-02: 资产 16500，nav=1.65，yearNav=1.65/1.5=1.1

    // 2025-01-02 计算
    const date = d('2025-01-02');
    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(16500, date));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2024-12-31'),
        shares: 10000,
        cumulativeNav: 1.5,
        baseCumulativeNav: 1.0, // 2024 年的基准
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const result = await service.calculateNavForDate('portfolio-1', date);

    expect(result).not.toBeNull();
    expect(result!.unitNav).toBeCloseTo(1.65, 4); // 16500/10000
    expect(result!.cumulativeNav).toBeCloseTo(1.65, 4);
    // 跨年 → yearNav = 1.0, base = 1.5
    expect(result!.yearNav).toBe(1.0);
    expect(result!.baseCumulativeNav).toBeCloseTo(1.5, 6);

    // 验证：如果继续到 2025-01-03
    const date2 = d('2025-01-03');
    mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(18150, date2));
    mockPrisma.dailyNav.findFirst.mockResolvedValue(
      makePrevNav({
        date: d('2025-01-02'),
        shares: 10000,
        cumulativeNav: 1.65,
        baseCumulativeNav: 1.5, // 继承年度基准
      }),
    );
    mockPrisma.transaction.findMany.mockResolvedValue([]);

    const result2 = await service.calculateNavForDate('portfolio-1', date2);
    expect(result2).not.toBeNull();
    expect(result2!.unitNav).toBeCloseTo(1.815, 4); // 18150/10000
    // 当年净值 = 1.815/1.5 = 1.21
    expect(result2!.yearNav).toBeCloseTo(1.21, 4);
  });
});
