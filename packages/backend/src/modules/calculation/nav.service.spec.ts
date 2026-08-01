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

  // ============================================================
  // K1 回归测试组 — 单位净值口径：nav_t = asset_t / shares_{t-1}
  //
  // 历史缺陷 K1：曾把当日申赎金额二次加减到资产快照上
  //   pureAssetValue = totalAsset - buyAmount + sellAmount
  //   unitNav = pureAssetValue / prevShares
  // 但资产快照口径本就是「当日申赎发生前」的持仓总额（PRD 3.3 / PRD 5.4 /
  // ARCHITECTURE 7.2 三处自洽），二次加减会让单位净值随当日申赎金额漂移，
  // 极端情况下甚至算出负净值。
  //
  // 下列用例锁定修复口径：单位净值只由「当日资产快照 / 上日末份额」决定，
  // 与当日申赎金额完全无关。每个用例在旧实现下都会失败。
  // ============================================================
  describe('K1 回归 — 单位净值不受当日申赎金额影响', () => {
    /** 统一场景：当日资产快照 12000，上日末份额 10000 → 单位净值恒为 1.2 */
    const SNAPSHOT_ASSET = 12000;
    const PREV_SHARES = 10000;
    const EXPECTED_NAV = 1.2;

    /** 按给定申赎组合装配 mock 并执行计算 */
    async function calcWithTrades(buy: number, sell: number) {
      const date = d('2024-01-02');
      const txs: ReturnType<typeof makeTx>[] = [];
      if (buy > 0) txs.push(makeTx('BUY', buy, date));
      if (sell > 0) txs.push(makeTx('SELL', sell, date));

      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(
        makeSnapshot(SNAPSHOT_ASSET, date),
      );
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-01-01'),
          shares: PREV_SHARES,
          cumulativeNav: 1.0,
          baseCumulativeNav: 1.0,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue(txs);

      return service.calculateNavForDate('portfolio-1', date);
    }

    // ----------------------------------------------------------
    // K1-1: 不变量 — 同一快照 + 同一上日份额，任意申赎组合下单位净值恒定
    // ----------------------------------------------------------
    it.each([
      { desc: '无申赎', buy: 0, sell: 0, expectedShares: 10000 },
      { desc: '仅买入 6000', buy: 6000, sell: 0, expectedShares: 15000 },
      { desc: '仅卖出 1200', buy: 0, sell: 1200, expectedShares: 9000 },
      { desc: '买入 6000 + 卖出 1200', buy: 6000, sell: 1200, expectedShares: 14000 },
      { desc: '买卖等额 3000（旧实现下误差恰好抵消）', buy: 3000, sell: 3000, expectedShares: 10000 },
      {
        desc: '买入额超过当日资产（旧实现会算出负净值 -0.8）',
        buy: 20000,
        sell: 0,
        expectedShares: 10000 + 20000 / 1.2,
      },
    ])(
      'should keep unitNav = asset/prevShares regardless of same-day flows — $desc',
      async ({ buy, sell, expectedShares }) => {
        const result = await calcWithTrades(buy, sell);

        expect(result).not.toBeNull();
        // 核心断言：单位净值与当日申赎金额无关
        expect(result!.unitNav).toBeCloseTo(EXPECTED_NAV, 6);
        expect(result!.cumulativeNav).toBeCloseTo(EXPECTED_NAV, 6);
        expect(result!.unitNav).toBeGreaterThan(0);
        // 申赎按该净值折算份额
        expect(result!.shares).toBeCloseTo(expectedShares, 4);
      },
    );

    // ----------------------------------------------------------
    // K1-2: 会计恒等式 — 当日末份额 × 单位净值 = 快照资产 + 净申购额
    // ----------------------------------------------------------
    it('should satisfy accounting identity: shares_t * nav_t = asset_t + buy - sell', async () => {
      const date = d('2024-03-15');
      const asset = 13750;
      const prevShares = 11000; // → nav = 1.25
      const buy = 4400;
      const sell = 1100;

      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(asset, date));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-03-14'),
          shares: prevShares,
          cumulativeNav: 1.1,
          baseCumulativeNav: 1.0,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue([
        makeTx('BUY', buy, date),
        makeTx('SELL', sell, date),
      ]);

      const result = await service.calculateNavForDate('portfolio-1', date);

      expect(result).not.toBeNull();
      expect(result!.unitNav).toBeCloseTo(1.25, 6); // 13750/11000
      // 11000 + 4400/1.25 - 1100/1.25 = 11000 + 3520 - 880 = 13640
      expect(result!.shares).toBeCloseTo(13640, 4);
      // 恒等式：13640 × 1.25 = 17050 = 13750 + 4400 - 1100
      expect(result!.shares * result!.unitNav).toBeCloseTo(asset + buy - sell, 4);
    });

    // ----------------------------------------------------------
    // K1-3: PRD 3.3 文档示例逐字回归（Day 30 / Day 60）
    // ----------------------------------------------------------
    it('should reproduce the PRD 3.3 worked example (Day30 nav=1.2, Day60 nav=1.1)', async () => {
      // Day 30：资产快照 12000，上日份额 10000 → 净值 1.2；又买入 6000 → 总份额 15000
      const day30 = d('2024-01-30');
      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(12000, day30));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-01-29'),
          shares: 10000,
          cumulativeNav: 1.0,
          baseCumulativeNav: 1.0,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 6000, day30)]);

      const r30 = await service.calculateNavForDate('portfolio-1', day30);
      expect(r30).not.toBeNull();
      expect(r30!.unitNav).toBeCloseTo(1.2, 6); // PRD: 12000/10000 = 1.2000
      expect(r30!.shares).toBeCloseTo(15000, 4); // PRD: 10000 + 6000/1.2 = 15000

      // Day 60：资产快照 16500，上日份额 15000 → 净值 1.1
      const day60 = d('2024-03-01');
      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(16500, day60));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-02-29'),
          shares: 15000,
          cumulativeNav: 1.2,
          baseCumulativeNav: 1.0,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      const r60 = await service.calculateNavForDate('portfolio-1', day60);
      expect(r60).not.toBeNull();
      expect(r60!.unitNav).toBeCloseTo(1.1, 6); // PRD: 16500/15000 = 1.1000
      expect(r60!.shares).toBeCloseTo(15000, 4); // 无申赎，份额不变
    });

    // ----------------------------------------------------------
    // K1-4: 边界 — 上日份额为 0 / 负数时返回 null，且不产生 NaN / Infinity
    // ----------------------------------------------------------
    it.each([
      { desc: '上日份额为 0（首笔尚未建仓）', prevShares: 0 },
      { desc: '上日份额为负（脏数据）', prevShares: -100 },
    ])('should return null without NaN/Infinity when prevShares <= 0 — $desc', async ({ prevShares }) => {
      const date = d('2024-01-02');

      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(10000, date));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-01-01'),
          shares: prevShares,
          cumulativeNav: 1.0,
          baseCumulativeNav: 1.0,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 5000, date)]);

      // 必须安全返回 null，而不是抛错或产出 Infinity/NaN 净值
      await expect(
        service.calculateNavForDate('portfolio-1', date),
      ).resolves.toBeNull();
    });

    // ----------------------------------------------------------
    // K1-5: 卖出金额超过当日持仓市值 → 抛 BadRequestException
    //
    // 该防护分支依赖正确的 unitNav：
    // 修复后 nav = 9000/10000 = 0.9，持仓市值 9000，卖 10000 → 份额转负 → 抛错。
    // 旧实现 nav = (9000+10000)/10000 = 1.9，持仓市值被虚增为 19000，
    // 份额仍为正 → 不抛错，超额赎回被静默放行。
    // ----------------------------------------------------------
    it('should throw BadRequestException when sell amount exceeds holding market value', async () => {
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
      mockPrisma.transaction.findMany.mockResolvedValue([makeTx('SELL', 10000, date)]);

      await expect(
        service.calculateNavForDate('portfolio-1', date),
      ).rejects.toThrow(BadRequestException);

      // 报错信息应基于正确口径的持仓市值 9000（旧实现会虚增为 19000）
      await expect(
        service.calculateNavForDate('portfolio-1', date),
      ).rejects.toThrow(/9000\.00/);
    });

    // ----------------------------------------------------------
    // K1-6: 跨年首日 + 当日申赎 — 年度字段同样不受申赎金额干扰
    // ----------------------------------------------------------
    it('should keep unitNav and year fields correct on year-first day with same-day buy', async () => {
      const date = d('2025-01-02');

      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(16000, date));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-12-31'),
          shares: 10000,
          cumulativeNav: 1.5,
          baseCumulativeNav: 1.2,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 8000, date)]);

      const result = await service.calculateNavForDate('portfolio-1', date);

      expect(result).not.toBeNull();
      // 净值仍为 16000/10000 = 1.6（旧实现会算成 (16000-8000)/10000 = 0.8）
      expect(result!.unitNav).toBeCloseTo(1.6, 6);
      expect(result!.shares).toBeCloseTo(10000 + 8000 / 1.6, 4); // 15000
      // 跨年 → yearNav 重置，base = 上年末累计净值
      expect(result!.yearNav).toBe(1.0);
      expect(result!.baseCumulativeNav).toBeCloseTo(1.5, 6);
    });
  });
});
