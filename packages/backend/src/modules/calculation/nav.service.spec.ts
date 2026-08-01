/**
 * 净值计算服务单元测试
 *
 * 测试 NavService.calculateNavForDate（份额法净值计算）。
 * 通过 mock PrismaService 隔离数据库依赖。
 *
 * 【资产快照口径】totalAsset = 当日期末总资产（含当日一切买入/卖出）。
 * 用户决策 D-06（2026-08-01）。因此：
 *   preAsset = totalAsset - buy + sell
 *   unitNav  = preAsset / prevShares
 *   shares_t = prevShares + (buy - sell) / unitNav
 *
 * 测试覆盖：
 * 1. 成立日：首笔买入 → nav=1.0, shares=buyAmount, base=1.0
 * 2. 非成立日（无交易）：nav=asset/prevShares, shares 不变
 * 3. 非成立日（有买入）：nav=(asset-buy)/prevShares，新增份额=buy/nav
 * 4. 非成立日（有卖出）：nav=(asset+sell)/prevShares，赎回份额=sell/nav
 * 5. 当年首日（跨年）：base=prevCumNav, yearNav=1.0
 * 6. 当年非首日：yearNav=cumNav/base
 * 7. 无快照返回 null
 * 8. 成立日无买入抛 BadRequestException
 * 9. preAsset <= 0 抛 BadRequestException
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
  // 无申赎时 preAsset === totalAsset，口径变更不影响本用例
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
  // 测试 3: 非成立日（有买入）— 期末资产 12000, 上日份额 10000, 买入 6000
  // preAsset = 12000 - 6000 = 6000 → nav = 0.6
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
    expect(result!.unitNav).toBeCloseTo(0.6, 6); // (12000-6000)/10000
    // 新增份额 = 6000/0.6 = 10000
    expect(result!.shares).toBeCloseTo(20000, 4); // 10000 + 10000
    expect(result!.cumulativeNav).toBeCloseTo(0.6, 6);
    expect(result!.yearNav).toBeCloseTo(0.6, 6); // 0.6/1.0
    // 不变量：期末资产 / 期末份额 = 单位净值
    expect(12000 / result!.shares).toBeCloseTo(result!.unitNav, 10);
  });

  // ----------------------------------------------------------
  // 测试 4: 非成立日（有卖出）— 期末资产 9000, 上日份额 10000, 卖出 900
  // preAsset = 9000 + 900 = 9900 → nav = 0.99
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
    expect(result!.unitNav).toBeCloseTo(0.99, 6); // (9000+900)/10000
    // 赎回份额 = 900/0.99 = 909.090909...
    expect(result!.shares).toBeCloseTo(10000 - 900 / 0.99, 4); // ≈ 9090.909091
    expect(result!.cumulativeNav).toBeCloseTo(0.99, 6);
    expect(result!.yearNav).toBeCloseTo(0.99, 6); // 0.99/1.0
    // 不变量：期末资产 / 期末份额 = 单位净值
    expect(9000 / result!.shares).toBeCloseTo(result!.unitNav, 10);
  });

  // ----------------------------------------------------------
  // 测试 4b: 非成立日（同时有买入和卖出）
  // preAsset = 12000 - 6000 + 1200 = 7200 → nav = 0.72
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
    expect(result!.unitNav).toBeCloseTo(0.72, 6); // (12000-6000+1200)/10000
    // 新增份额 = 6000/0.72, 赎回份额 = 1200/0.72 → 净增 4800/0.72 = 6666.666667
    expect(result!.shares).toBeCloseTo(10000 + 4800 / 0.72, 4); // ≈ 16666.666667
    // 不变量：期末资产 / 期末份额 = 单位净值
    expect(12000 / result!.shares).toBeCloseTo(result!.unitNav, 10);
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
  // 资产快照口径测试组 — totalAsset = 当日期末总资产（含当日申赎）
  //
  // 口径依据：用户决策 D-06（2026-08-01）。
  // 用户在券商 App 上看到的就是「期末总资产」这一个数字，录入零心智负担；
  // 「申赎前资产」用户根本看不到，无法录入。
  //
  // 由该口径推导：
  //   preAsset = totalAsset - buy + sell            （申赎前持仓资产）
  //   unitNav  = preAsset / prevShares
  //   shares_t = prevShares + (buy - sell) / unitNav
  //            = prevShares × totalAsset / preAsset （等价闭式）
  //   不变量   : totalAsset / shares_t === unitNav
  //
  // 注意：本组用例替代了此前的「K1 回归 — 单位净值不受当日申赎金额影响」，
  // 那组用例基于「快照 = 申赎前资产」的旧口径，语义与本口径完全相反。
  // 在新口径下，单位净值恰恰必须扣除当日买入、加回当日卖出，
  // 否则当日买入的本金会被当成收益（xirr.service 则会把它当成流出而蒸发）。
  // ============================================================
  describe('资产快照口径 — 期末总资产（含当日申赎）', () => {
    const PREV_SHARES = 10000;

    /** 按给定期末资产与申赎组合装配 mock 并执行计算 */
    async function calcWith(totalAsset: number, buy: number, sell: number, prevShares = PREV_SHARES) {
      const date = d('2024-01-02');
      const txs: ReturnType<typeof makeTx>[] = [];
      if (buy > 0) txs.push(makeTx('BUY', buy, date));
      if (sell > 0) txs.push(makeTx('SELL', sell, date));

      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(totalAsset, date));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: d('2024-01-01'),
          shares: prevShares,
          cumulativeNav: 1.0,
          baseCumulativeNav: 1.0,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue(txs);

      return service.calculateNavForDate('portfolio-1', date);
    }

    // ----------------------------------------------------------
    // D06-1: 当日无交易 — unitNav = totalAsset / prevShares
    // ----------------------------------------------------------
    it('should compute unitNav = totalAsset / prevShares when there is no same-day flow', async () => {
      const result = await calcWith(12000, 0, 0);

      expect(result).not.toBeNull();
      expect(result!.unitNav).toBeCloseTo(1.2, 10); // 12000/10000
      expect(result!.cumulativeNav).toBeCloseTo(1.2, 10);
      expect(result!.shares).toBeCloseTo(10000, 6); // 份额不变
    });

    // ----------------------------------------------------------
    // D06-2: 当日有买入 — unitNav = (totalAsset - buy) / prevShares
    // 买入本金已包含在期末资产中，必须扣除后才是当日持仓表现
    // ----------------------------------------------------------
    it('should compute unitNav = (totalAsset - buy) / prevShares when there is a same-day buy', async () => {
      // 期末 15500，其中 5000 是当日买入 → 申赎前 10500 → nav = 1.05
      const result = await calcWith(15500, 5000, 0);

      expect(result).not.toBeNull();
      expect(result!.unitNav).toBeCloseTo(1.05, 10);
      // 若误用旧口径（不扣买入）会得到 1.55 —— 把 5000 元本金当成了收益
      expect(result!.unitNav).not.toBeCloseTo(1.55, 4);
      expect(result!.shares).toBeCloseTo(10000 + 5000 / 1.05, 6);
    });

    // ----------------------------------------------------------
    // D06-3: 当日有卖出 — unitNav = (totalAsset + sell) / prevShares
    // 卖出的钱已离开账户，必须加回才能还原申赎前持仓
    // ----------------------------------------------------------
    it('should compute unitNav = (totalAsset + sell) / prevShares when there is a same-day sell', async () => {
      // 期末 9000，当日卖出 2000 → 申赎前 11000 → nav = 1.1
      const result = await calcWith(9000, 0, 2000);

      expect(result).not.toBeNull();
      expect(result!.unitNav).toBeCloseTo(1.1, 10);
      // 若误用旧口径（不加回卖出）会得到 0.9 —— 把已落袋的 2000 元当成了亏损
      expect(result!.unitNav).not.toBeCloseTo(0.9, 4);
      expect(result!.shares).toBeCloseTo(10000 - 2000 / 1.1, 6);
    });

    // ----------------------------------------------------------
    // D06-4: 买卖同日并存 — preAsset = totalAsset - buy + sell
    // ----------------------------------------------------------
    it('should compute unitNav = (totalAsset - buy + sell) / prevShares when buy and sell coexist', async () => {
      // 期末 13000，当日买 5000、卖 2000 → 申赎前 10000 → nav = 1.0
      const result = await calcWith(13000, 5000, 2000);

      expect(result).not.toBeNull();
      expect(result!.unitNav).toBeCloseTo(1.0, 10);
      // 净增份额 = (5000 - 2000)/1.0 = 3000
      expect(result!.shares).toBeCloseTo(13000, 6);
    });

    // ----------------------------------------------------------
    // D06-5: 不变量 — totalAsset / shares_t === unitNav
    // 期末资产 ÷ 期末份额 = 当日单位净值，这是新口径的自洽性锚点
    // ----------------------------------------------------------
    it.each([
      { desc: '无申赎', asset: 12000, buy: 0, sell: 0 },
      { desc: '仅买入 5000', asset: 15500, buy: 5000, sell: 0 },
      { desc: '仅卖出 2000', asset: 9000, buy: 0, sell: 2000 },
      { desc: '买 5000 + 卖 2000', asset: 13000, buy: 5000, sell: 2000 },
      { desc: '买卖等额 3000', asset: 12000, buy: 3000, sell: 3000 },
      { desc: '除不尽的小数', asset: 13750, buy: 4400, sell: 1100 },
      { desc: '买入额接近期末资产', asset: 12000, buy: 11999, sell: 0 },
    ])(
      'should satisfy invariant totalAsset / shares === unitNav — $desc',
      async ({ asset, buy, sell }) => {
        const result = await calcWith(asset, buy, sell, 11000);

        expect(result).not.toBeNull();
        expect(Number.isFinite(result!.unitNav)).toBe(true);
        expect(Number.isFinite(result!.shares)).toBe(true);
        expect(result!.unitNav).toBeGreaterThan(0);
        expect(result!.shares).toBeGreaterThan(0);
        // 核心不变量
        expect(asset / result!.shares).toBeCloseTo(result!.unitNav, 10);
        // 等价闭式：shares = prevShares × totalAsset / preAsset
        expect(result!.shares).toBeCloseTo((11000 * asset) / (asset - buy + sell), 6);
      },
    );

    // ----------------------------------------------------------
    // D06-6: preAsset <= 0 → 抛 BadRequestException
    //
    // 买入额 >= 期末资产 + 卖出额 在现实中不可能发生
    // （买进去的钱当天必然计入期末资产），只可能是录入错误。
    // 若放行：preAsset = 0 → shares 变 NaN；preAsset < 0 → 负净值负份额。
    // ----------------------------------------------------------
    it.each([
      { desc: 'preAsset = 0（买入额恰好等于期末资产）', asset: 6000, buy: 6000, sell: 0 },
      { desc: 'preAsset < 0（买入额超过期末资产）', asset: 12000, buy: 20000, sell: 0 },
      { desc: 'preAsset < 0（含卖出仍不足）', asset: 5000, buy: 9000, sell: 1000 },
    ])('should throw BadRequestException when preAsset <= 0 — $desc', async ({ asset, buy, sell }) => {
      await expect(calcWith(asset, buy, sell)).rejects.toThrow(BadRequestException);
    });

    it('should report the date, the buy amount and the end-of-day asset in the preAsset error message', async () => {
      // 级联重算时错误可能来自任意历史日期，必须带上日期
      await expect(calcWith(12000, 20000, 0)).rejects.toThrow(/2024-01-02/);
      await expect(calcWith(12000, 20000, 0)).rejects.toThrow(/当日买入金额 20000\.00/);
      await expect(calcWith(12000, 20000, 0)).rejects.toThrow(/超过当日期末资产 12000\.00/);
      await expect(calcWith(12000, 20000, 0)).rejects.toThrow(/请检查录入/);
    });

    // ----------------------------------------------------------
    // D06-7: 大额卖出不再是「过度赎回」
    //
    // 旧口径下 asset=9000 / sell=10000 被判为超额赎回并抛错；
    // 新口径下期末 9000 + 已卖出 10000 = 申赎前 19000，nav=1.9 完全正确，
    // 份额恒为正，不应抛错。
    // ----------------------------------------------------------
    it('should NOT treat a large same-day sell as over-redemption under the end-of-day caliber', async () => {
      const result = await calcWith(9000, 0, 10000);

      expect(result).not.toBeNull();
      expect(result!.unitNav).toBeCloseTo(1.9, 10); // (9000+10000)/10000
      expect(result!.shares).toBeCloseTo(10000 - 10000 / 1.9, 6); // ≈ 4736.842105
      expect(result!.shares).toBeGreaterThan(0);
      expect(9000 / result!.shares).toBeCloseTo(result!.unitNav, 10);
    });

    // ----------------------------------------------------------
    // D06-8: 用户算例端到端
    // 7/1 买入 10000（成立日，快照 10000）
    // 7/15 买入 5000，期末快照 15500
    // → 本金 15000，资产 15500，收益 500 元，unitNav = 1.0500
    // ----------------------------------------------------------
    it('should reproduce the user worked example: 7/1 buy 10000 → 7/15 buy 5000 with 15500 snapshot', async () => {
      // ---- Day 1：2024-07-01 成立日 ----
      const day1 = d('2024-07-01');
      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(10000, day1));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(null);
      mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 10000, day1)]);

      const r1 = await service.calculateNavForDate('portfolio-1', day1);
      expect(r1).not.toBeNull();
      expect(r1!.unitNav).toBe(1.0);
      expect(r1!.shares).toBe(10000);

      // ---- Day 2：2024-07-15 买入 5000，期末资产 15500 ----
      const day2 = d('2024-07-15');
      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(15500, day2));
      mockPrisma.dailyNav.findFirst.mockResolvedValue(
        makePrevNav({
          date: day1,
          shares: r1!.shares,
          cumulativeNav: r1!.cumulativeNav,
          baseCumulativeNav: r1!.baseCumulativeNav,
        }),
      );
      mockPrisma.transaction.findMany.mockResolvedValue([makeTx('BUY', 5000, day2)]);

      const r2 = await service.calculateNavForDate('portfolio-1', day2);
      expect(r2).not.toBeNull();
      // 申赎前资产 = 15500 - 5000 = 10500 → nav = 10500/10000 = 1.0500
      expect(r2!.unitNav).toBeCloseTo(1.05, 10);
      expect(r2!.cumulativeNav).toBeCloseTo(1.05, 10);
      // 份额 = 10000 + 5000/1.05 = 14761.904762
      expect(r2!.shares).toBeCloseTo(14761.904762, 6);
      // 不变量：15500 / 14761.904762 = 1.05
      expect(15500 / r2!.shares).toBeCloseTo(r2!.unitNav, 10);

      // 与 XIRR 口径的一致性：本金 15000，期末 15500 → 绝对收益 500 元
      const principal = 10000 + 5000;
      const profitFromNav = 15500 - principal;
      expect(profitFromNav).toBeCloseTo(500, 6);
      // 旧口径 nav=1.55 会隐含 5500 元收益，与 XIRR 的 500 元相差 5000 元
      expect(r2!.unitNav).not.toBeCloseTo(1.55, 4);
    });

    // ----------------------------------------------------------
    // D06-9: 跨年首日 + 当日买入 — 年度字段与口径修正互不干扰
    // ----------------------------------------------------------
    it('should keep year fields correct on year-first day with same-day buy', async () => {
      const date = d('2025-01-02');

      mockPrisma.assetSnapshot.findUnique.mockResolvedValue(makeSnapshot(24000, date));
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
      // 申赎前资产 = 24000 - 8000 = 16000 → nav = 1.6
      expect(result!.unitNav).toBeCloseTo(1.6, 10);
      expect(result!.shares).toBeCloseTo(10000 + 8000 / 1.6, 6); // 15000
      // 跨年 → yearNav 重置，base = 上年末累计净值
      expect(result!.yearNav).toBe(1.0);
      expect(result!.baseCumulativeNav).toBeCloseTo(1.5, 6);
      // 不变量
      expect(24000 / result!.shares).toBeCloseTo(result!.unitNav, 10);
    });

    // ----------------------------------------------------------
    // D06-10: prevShares <= 0 优先于 preAsset 校验 — 返回 null 而非抛错
    // ----------------------------------------------------------
    it.each([
      { desc: '上日份额为 0', prevShares: 0 },
      { desc: '上日份额为负（脏数据）', prevShares: -100 },
    ])('should return null without NaN/Infinity when prevShares <= 0 — $desc', async ({ prevShares }) => {
      await expect(calcWith(10000, 5000, 0, prevShares)).resolves.toBeNull();
    });
  });
});
