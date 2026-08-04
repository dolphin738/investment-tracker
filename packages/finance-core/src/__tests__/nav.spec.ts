/**
 * computeNav 纯函数单元测试
 *
 * 【口径以 caliber-consistency.spec 为准】
 * 本文件不新造口径：所有期望值均取自既有的已校准测试——
 * - 口径锚点 `shares × unitNav === totalAsset`：caliber-consistency.spec A 组的普适判据；
 * - 用户算例（7/1 买 10000 → 7/15 买 5000，快照 15500 → unitNav 1.05、
 *   shares 14761.904762、隐含终值 15500）：caliber-consistency.spec B 组；
 * - 跨年基准 baseCumulativeNav = 1.1：caliber-consistency.spec D 组；
 * - 异常文案与 prevShares <= 0 返回 null：backend nav.service.spec.ts D06 组。
 *
 * 本文件的作用是把上述已固化的口径下沉到纯函数层，
 * 使 finance-core 可脱离 Prisma / NestJS 独立验证。
 */

import { NavCalculationError, computeNav } from '../index';
import type { PrevNav } from '../index';

/** 创建 Date 对象（使用 UTC 午夜，与生产代码写库口径一致） */
function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z');
}

/** 构造上日净值记录 */
function prev(
  dateStr: string,
  shares: number,
  cumulativeNav: number,
  baseCumulativeNav: number | null = 1.0,
): PrevNav {
  return { date: d(dateStr), shares, cumulativeNav, baseCumulativeNav };
}

// ============================================================
// 成立日
// ============================================================

describe('computeNav — 成立日（prevNav = null）', () => {
  it('should return nav 1.0 and shares = buyAmount on inception day', () => {
    const result = computeNav({
      totalAsset: 10000,
      prevNav: null,
      buyAmount: 10000,
      sellAmount: 0,
      date: d('2024-01-01'),
    });

    expect(result).toEqual({
      unitNav: 1.0,
      cumulativeNav: 1.0,
      yearNav: 1.0,
      shares: 10000,
      baseCumulativeNav: 1.0,
    });
  });

  it('should throw INCEPTION_WITHOUT_BUY when there is no buy on inception day', () => {
    const call = () =>
      computeNav({
        totalAsset: 10000,
        prevNav: null,
        buyAmount: 0,
        sellAmount: 0,
        date: d('2024-01-01'),
      });

    expect(call).toThrow(NavCalculationError);
    expect(call).toThrow('首笔交易必须为买入（2024-01-01 为成立日，需要有买入交易）');
    try {
      call();
    } catch (error) {
      expect((error as NavCalculationError).code).toBe('INCEPTION_WITHOUT_BUY');
    }
  });
});

// ============================================================
// 非成立日 — 口径锚点（caliber-consistency.spec A 组的普适判据）
// ============================================================

describe('computeNav — 口径锚点：shares × unitNav === totalAsset', () => {
  const CASES: Array<{ desc: string; totalAsset: number; buy: number; sell: number }> = [
    { desc: '当日无交易', totalAsset: 11000, buy: 0, sell: 0 },
    { desc: '当日有买入', totalAsset: 16000, buy: 5000, sell: 0 },
    { desc: '当日有卖出', totalAsset: 7000, buy: 0, sell: 3000 },
    { desc: '买卖同日并存', totalAsset: 14000, buy: 4000, sell: 1000 },
    { desc: '除不尽的金额', totalAsset: 4691.23, buy: 1111.11, sell: 0 },
  ];

  it.each(CASES)('$desc — 隐含账户价值必须等于期末总资产', ({ totalAsset, buy, sell }) => {
    const result = computeNav({
      totalAsset,
      prevNav: prev('2024-01-01', 10000, 1.0),
      buyAmount: buy,
      sellAmount: sell,
      date: d('2024-02-01'),
    })!;

    // 口径锚点：nav 引擎隐含的账户价值 === xirr 引擎使用的终值
    expect(result.shares * result.unitNav).toBeCloseTo(totalAsset, 6);

    // 数值卫生：不得泄漏 NaN / Infinity
    expect(Number.isFinite(result.unitNav)).toBe(true);
    expect(Number.isFinite(result.cumulativeNav)).toBe(true);
    expect(Number.isFinite(result.yearNav)).toBe(true);
    expect(Number.isFinite(result.shares)).toBe(true);
    expect(result.unitNav).toBeGreaterThan(0);
    expect(result.shares).toBeGreaterThan(0);
  });

  it('should price on preAsset = totalAsset - buy + sell（期末口径 D-06）', () => {
    const result = computeNav({
      totalAsset: 14000,
      prevNav: prev('2024-01-01', 10000, 1.0),
      buyAmount: 4000,
      sellAmount: 1000,
      date: d('2024-02-01'),
    })!;

    // preAsset = 14000 - 4000 + 1000 = 11000 → unitNav = 1.1
    expect(result.unitNav).toBeCloseTo(1.1, 10);
    expect(result.cumulativeNav).toBe(result.unitNav);
  });

  it('用户算例：7/1 买 10000 → 7/15 买 5000、快照 15500 → unitNav 1.05', () => {
    // 与 caliber-consistency.spec B 组逐值对齐
    const result = computeNav({
      totalAsset: 15500,
      prevNav: prev('2024-07-01', 10000, 1.0),
      buyAmount: 5000,
      sellAmount: 0,
      date: d('2024-07-15'),
    })!;

    expect(result.unitNav).toBeCloseTo(1.05, 8);
    expect(result.shares).toBeCloseTo(14761.904762, 5);
    expect(result.shares * result.unitNav).toBeCloseTo(15500, 6);

    // 旧口径会得到 unitNav 1.55 / 隐含终值 20500，差额 5000 —— 不得退回
    expect(result.unitNav).not.toBeCloseTo(1.55, 3);
  });
});

// ============================================================
// 年度重置
// ============================================================

describe('computeNav — 年度净值分支', () => {
  it('should reset yearNav to 1.0 and adopt prev cumulativeNav as base on year-first day', () => {
    const result = computeNav({
      totalAsset: 11500,
      prevNav: prev('2024-12-20', 10000, 1.1, 1.0),
      buyAmount: 0,
      sellAmount: 0,
      date: d('2025-01-10'),
    })!;

    expect(result.unitNav).toBeCloseTo(1.15, 10);
    expect(result.yearNav).toBe(1.0);
    expect(result.baseCumulativeNav).toBeCloseTo(1.1, 6);
  });

  it('should inherit the in-year base and derive yearNav on a non-first day of the year', () => {
    // 承接上一条：2025 年内基准 1.1，2025-06-15 资产 13000 → cumulativeNav 1.3
    const result = computeNav({
      totalAsset: 13000,
      prevNav: prev('2025-01-10', 10000, 1.15, 1.1),
      buyAmount: 0,
      sellAmount: 0,
      date: d('2025-06-15'),
    })!;

    expect(result.cumulativeNav).toBeCloseTo(1.3, 8);
    expect(result.baseCumulativeNav).toBeCloseTo(1.1, 6);
    expect(result.yearNav).toBeCloseTo(1.3 / 1.1, 8);
  });

  it('should fall back to yearNav 1.0 when the inherited base is absent', () => {
    const result = computeNav({
      totalAsset: 13000,
      prevNav: prev('2024-02-01', 10000, 1.15, null),
      buyAmount: 0,
      sellAmount: 0,
      date: d('2024-03-01'),
    })!;

    expect(result.baseCumulativeNav).toBeNull();
    expect(result.yearNav).toBe(1.0);
  });
});

// ============================================================
// 防御分支（保持原样，见 nav.service.spec.ts D06 组）
// ============================================================

describe('computeNav — 防御分支', () => {
  it.each([
    { desc: '上日份额为 0', prevShares: 0 },
    { desc: '上日份额为负（脏数据）', prevShares: -100 },
  ])('should return null without NaN/Infinity when prevShares <= 0 — $desc', ({ prevShares }) => {
    const result = computeNav({
      totalAsset: 10000,
      prevNav: prev('2024-01-01', prevShares, 1.0),
      buyAmount: 5000,
      sellAmount: 0,
      date: d('2024-01-02'),
    });

    expect(result).toBeNull();
  });

  it.each([
    { desc: '买入等于期末资产', asset: 10000, buy: 10000, sell: 0 },
    { desc: '买入超过期末资产', asset: 12000, buy: 20000, sell: 0 },
  ])(
    'should throw NON_POSITIVE_PRE_ASSET when preAsset <= 0 — $desc',
    ({ asset, buy, sell }) => {
      const call = () =>
        computeNav({
          totalAsset: asset,
          prevNav: prev('2024-01-01', 10000, 1.0),
          buyAmount: buy,
          sellAmount: sell,
          date: d('2024-01-02'),
        });

      expect(call).toThrow(NavCalculationError);
      try {
        call();
      } catch (error) {
        expect((error as NavCalculationError).code).toBe('NON_POSITIVE_PRE_ASSET');
      }
    },
  );

  it('should report the date, the buy amount and the end-of-day asset in the preAsset error message', () => {
    const call = () =>
      computeNav({
        totalAsset: 12000,
        prevNav: prev('2024-01-01', 10000, 1.0),
        buyAmount: 20000,
        sellAmount: 0,
        date: d('2024-01-02'),
      });

    expect(call).toThrow(/2024-01-02/);
    expect(call).toThrow(/当日买入金额 20000\.00/);
    expect(call).toThrow(/超过当日期末资产 12000\.00/);
    expect(call).toThrow(/请检查录入/);
  });

  it('should NOT treat a large same-day sell as over-redemption under the end-of-day caliber', () => {
    // 期末口径下卖出会加回 preAsset，不构成超额赎回
    const result = computeNav({
      totalAsset: 2000,
      prevNav: prev('2024-01-01', 10000, 1.0),
      buyAmount: 0,
      sellAmount: 9000,
      date: d('2024-01-02'),
    })!;

    expect(result.unitNav).toBeCloseTo(1.1, 10);
    expect(result.shares * result.unitNav).toBeCloseTo(2000, 6);
  });
});

// ============================================================
// Prisma Decimal 透传语义
// ============================================================

describe('computeNav — Prisma Decimal-like 透传', () => {
  /** Prisma 的 Decimal 是对象；本包不引 @prisma/client，用结构等价替身验证 */
  const decimal = (v: string) => ({ toString: () => v });

  it('should coerce Decimal-like inputs exactly like Number(x)', () => {
    const result = computeNav({
      totalAsset: decimal('15500'),
      prevNav: {
        date: d('2024-07-01'),
        shares: decimal('10000'),
        cumulativeNav: decimal('1'),
        baseCumulativeNav: decimal('1'),
      },
      buyAmount: 5000,
      sellAmount: 0,
      date: d('2024-07-15'),
    })!;

    expect(result.unitNav).toBeCloseTo(1.05, 8);
    expect(result.shares).toBeCloseTo(14761.904762, 5);
  });

  // Decimal(0) 原为 truthy 对象 → 走 Number 分支 → yearNav 除以 0 得 Infinity。
  // 修复后改用 Number(x) > 0 数值判断，Decimal(0) 落入 null 分支，yearNav 回退 1.0。
  it('should treat a Decimal-like zero base as null and fall back to yearNav 1.0', () => {
    // ⚠️ 行为已修复：原实现 `prevNav.baseCumulativeNav ? Number(...) : null`
    // 对 Prisma Decimal(0)（truthy 对象）会走 Number 分支得 0，yearNav = Infinity。
    // 现改为 `Number(prevNav.baseCumulativeNav) > 0 ? ...`，Decimal(0) 落入 null 分支。
    const result = computeNav({
      totalAsset: 13000,
      prevNav: {
        date: d('2024-02-01'),
        shares: decimal('10000'),
        cumulativeNav: decimal('1.15'),
        baseCumulativeNav: decimal('0'),
      },
      buyAmount: 0,
      sellAmount: 0,
      date: d('2024-03-01'),
    })!;

    expect(result.baseCumulativeNav).toBeNull();
    expect(result.yearNav).toBe(1.0);
  });
});
