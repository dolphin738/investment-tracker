/**
 * RecalculationService — 孤儿 DERIVED 快照清理（问题⑧）验收测试
 *
 * 【场景】某日 D 原本只有一笔 cashflow（无持仓、无现金余额），用户删除该 cashflow 后：
 * - D 不再是事件日 → 步骤 ① 的 `DELETE ... date IN eventDates` 删不到 D 的旧 DERIVED 行；
 * - 但 `recalculateNavRange` 的快照日期集合仍含 D → 对 D 算 NAV，得 totalAsset=0；
 * - 结果：留下 0 值孤儿 DERIVED 快照，持续污染净值/XIRR。
 *
 * 【验收点】
 * 1. 孤儿日（非事件日 + 派生值恒 0）的 asset_snapshot / daily_nav / daily_xirr 被物理删除；
 * 2. 清理发生在 NAV 级联**之前** —— 孤儿日不得进入 triggerCalculation（0 值不污染净值链）；
 * 3. 事件日的 DERIVED 快照绝不被清理；
 * 4. 非事件日但派生值非 0（仍有持仓/现金）的 DERIVED 快照保留；
 * 5. 非事件日的 MANUAL 记录绝不被误删；
 * 6. 无候选时不发起清理事务（零额外开销）。
 *
 * prisma / assetValuation / calculationService 全部 mock，不触库。
 */

import 'reflect-metadata';
import { RecalculationService } from './recalculation.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type {
  AssetValuationService,
  DerivedResult,
} from '../valuation/asset-valuation.service';
import type { CalculationService } from '../calculation/calculation.service';
import { SnapshotValuation } from '@investment-tracker/shared';

const PORTFOLIO_ID = 'pf-1';

/** YYYY-MM-DD → UTC 午夜 Date（与 @db.Date 口径一致） */
function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** YYYY-MM-DD 键 */
function key(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** 构造派生结果 */
function derived(marketValue: number, cashBalance: number): DerivedResult {
  return {
    totalAsset: marketValue + cashBalance,
    marketValue,
    cashBalance,
    valuationFlag: SnapshotValuation.EXACT,
  };
}

interface SetupOptions {
  /** 事件日（cashflow / trade / price / cash 的并集，不含 today） */
  eventDates: string[];
  /** asset_snapshots 表中实际存在的行 */
  snapshotRows: { date: string; source: 'DERIVED' | 'MANUAL' }[];
  /** 各日期的派生值（缺省 = 全 0，即孤儿） */
  derivedByDate?: Record<string, DerivedResult>;
}

/** deleteMany 的 where 形状（本 spec 用到的子集） */
interface DeleteWhere {
  portfolioId: string;
  date: { in: Date[] };
  source?: string;
}

/**
 * 有状态的 prisma 桩：asset_snapshots 表用可变数组模拟。
 *
 * 🔴 必须有状态 —— 步骤 ① 的 DELETE、步骤 ② 的 persistDerived 回填、
 * 步骤 ②.5 的清理都会改变表内容，而步骤 ③ 的快照日期集合正是读这张表。
 * 若 findMany 返回静态数组，「孤儿日已被移出级联」这条关键验收点就失去判别力。
 */
function setup(options: SetupOptions) {
  const { eventDates, snapshotRows, derivedByDate = {} } = options;

  /** 表内实时行（会被 deleteMany / persistDerived 改写） */
  let liveRows: { date: string; source: 'DERIVED' | 'MANUAL' }[] = [
    ...snapshotRows,
  ];

  const cashFlowFindMany = jest
    .fn()
    .mockResolvedValue(eventDates.map((s) => ({ date: d(s) })));
  const securityTradeFindMany = jest.fn().mockResolvedValue([]);
  const securityPriceFindMany = jest.fn().mockResolvedValue([]);
  const cashBalanceFindMany = jest.fn().mockResolvedValue([]);

  /** 真删表内行，返回哨兵值（供 $transaction 断言） */
  const assetSnapshotDeleteMany = jest.fn((args: { where: DeleteWhere }) => {
    const targets = new Set(args.where.date.in.map(key));
    liveRows = liveRows.filter(
      (r) =>
        !(
          targets.has(r.date) &&
          (args.where.source === undefined || r.source === args.where.source)
        ),
    );
    return 'del-snapshot';
  });
  const dailyNavDeleteMany = jest.fn().mockReturnValue('del-nav');
  const dailyXirrDeleteMany = jest.fn().mockReturnValue('del-xirr');
  const assetSnapshotCount = jest.fn(() =>
    Promise.resolve(liveRows.filter((r) => r.source === 'MANUAL').length),
  );

  /**
   * assetSnapshot.findMany 有两个调用点，用 where 形状区分：
   * - 清理步骤 ②.5：where.source === 'DERIVED'
   * - NAV 级联 ③：distinct: ['date']，无 source 过滤
   */
  const assetSnapshotFindMany = jest.fn(
    (args: {
      where?: { source?: string };
      distinct?: string[];
    }): Promise<{ date: Date }[]> => {
      const rows =
        args?.where?.source === 'DERIVED'
          ? liveRows.filter((r) => r.source === 'DERIVED')
          : liveRows;
      return Promise.resolve(
        [...rows].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
          date: d(r.date),
        })),
      );
    },
  );

  const transaction = jest.fn().mockResolvedValue([]);

  const prisma = {
    cashFlow: { findMany: cashFlowFindMany },
    securityTrade: { findMany: securityTradeFindMany },
    securityPrice: { findMany: securityPriceFindMany },
    cashBalance: { findMany: cashBalanceFindMany },
    assetSnapshot: {
      findMany: assetSnapshotFindMany,
      deleteMany: assetSnapshotDeleteMany,
      count: assetSnapshotCount,
    },
    dailyNav: { deleteMany: dailyNavDeleteMany },
    dailyXirr: { deleteMany: dailyXirrDeleteMany },
    $transaction: transaction,
  };

  /** 步骤 ② 回填：无行则新建 DERIVED，遇 MANUAL 跳过（与真实实现一致） */
  const persistDerived = jest.fn((_pid: string, date: Date) => {
    const k = key(date);
    const existing = liveRows.find((r) => r.date === k);
    if (existing) {
      if (existing.source === 'MANUAL') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    }
    liveRows.push({ date: k, source: 'DERIVED' });
    return Promise.resolve(undefined);
  });

  const computeDerivedBatch = jest.fn(
    (_pid: string, dates: readonly Date[]): Promise<Map<string, DerivedResult>> => {
      const map = new Map<string, DerivedResult>();
      for (const date of dates) {
        map.set(key(date), derivedByDate[key(date)] ?? derived(0, 0));
      }
      return Promise.resolve(map);
    },
  );

  const assetValuation = { persistDerived, computeDerivedBatch };

  /** 读取当前表内行（断言用） */
  const currentRows = () => [...liveRows].sort((a, b) => a.date.localeCompare(b.date));

  /** 记录级联实际算了哪些日期（验收点 2 靠它） */
  const calculatedDates: string[] = [];
  const triggerCalculation = jest.fn((_pid: string, date: Date) => {
    calculatedDates.push(key(date));
    return Promise.resolve(undefined);
  });
  const calculationService = { triggerCalculation };

  const service = new RecalculationService(
    prisma as unknown as PrismaService,
    assetValuation as unknown as AssetValuationService,
    calculationService as unknown as CalculationService,
  );

  return {
    service,
    prisma,
    transaction,
    assetSnapshotDeleteMany,
    dailyNavDeleteMany,
    dailyXirrDeleteMany,
    computeDerivedBatch,
    calculatedDates,
    triggerCalculation,
    currentRows,
  };
}

describe('RecalculationService — 孤儿 DERIVED 快照清理（问题⑧）', () => {
  const START = d('2025-01-01');
  const END = d('2025-01-31');

  it('删旧 cashflow 后：该日 DERIVED 快照 + nav + xirr 被清理，不留 totalAsset=0 孤儿', async () => {
    // 2025-01-10 原本仅有一笔 cashflow，现已删除 → 不在 eventDates，但快照仍在
    const ctx = setup({
      eventDates: ['2025-01-05'],
      snapshotRows: [
        { date: '2025-01-05', source: 'DERIVED' },
        { date: '2025-01-10', source: 'DERIVED' },
      ],
      derivedByDate: {
        // 孤儿日：无持仓、无现金
        '2025-01-10': derived(0, 0),
      },
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(1);

    // 三张表都删了 2025-01-10
    expect(ctx.assetSnapshotDeleteMany).toHaveBeenCalledWith({
      where: {
        portfolioId: PORTFOLIO_ID,
        date: { in: [d('2025-01-10')] },
        source: 'DERIVED',
      },
    });
    expect(ctx.dailyNavDeleteMany).toHaveBeenCalledWith({
      where: { portfolioId: PORTFOLIO_ID, date: { in: [d('2025-01-10')] } },
    });
    expect(ctx.dailyXirrDeleteMany).toHaveBeenCalledWith({
      where: { portfolioId: PORTFOLIO_ID, date: { in: [d('2025-01-10')] } },
    });

    // 清理走事务（快照/nav/xirr 原子删除）
    expect(ctx.transaction).toHaveBeenCalledWith([
      'del-snapshot',
      'del-nav',
      'del-xirr',
    ]);

    // 表内不再有 2025-01-10 的行（不留 totalAsset=0 孤儿）
    expect(ctx.currentRows()).toEqual([
      { date: '2025-01-05', source: 'DERIVED' },
    ]);
  });

  it('清理发生在 NAV 级联之前 —— 孤儿日不进入 triggerCalculation（0 值不污染净值链）', async () => {
    const ctx = setup({
      eventDates: ['2025-01-05'],
      snapshotRows: [
        { date: '2025-01-05', source: 'DERIVED' },
        { date: '2025-01-10', source: 'DERIVED' },
      ],
    });

    await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    // 🔴 关键：级联执行时孤儿日已被移出快照集合
    expect(ctx.calculatedDates).not.toContain('2025-01-10');

    // 清理事务必须先于任何一次 triggerCalculation 发生
    const cleanupOrder = ctx.transaction.mock.invocationCallOrder[0];
    const firstCalcOrder = ctx.triggerCalculation.mock.invocationCallOrder[0];
    expect(cleanupOrder).toBeLessThan(firstCalcOrder);
  });

  it('事件日的 DERIVED 快照不被清理', async () => {
    const ctx = setup({
      eventDates: ['2025-01-05'],
      // 2025-01-05 是事件日，即便派生值为 0 也必须保留
      snapshotRows: [{ date: '2025-01-05', source: 'DERIVED' }],
      derivedByDate: { '2025-01-05': derived(0, 0) },
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(0);
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.calculatedDates).toContain('2025-01-05');
  });

  it('非事件日但派生值非 0（仍有持仓/现金）→ 保留，不误清', async () => {
    const ctx = setup({
      eventDates: ['2025-01-05'],
      snapshotRows: [
        { date: '2025-01-05', source: 'DERIVED' },
        { date: '2025-01-10', source: 'DERIVED' },
      ],
      derivedByDate: {
        // 该日无事件，但历史持仓仍在 → 非孤儿
        '2025-01-10': derived(12345.67, 0),
      },
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(0);
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.calculatedDates).toContain('2025-01-10');
  });

  it('仅现金余额非 0 → 保留（cashBalance 参与判据）', async () => {
    const ctx = setup({
      eventDates: [],
      snapshotRows: [{ date: '2025-01-10', source: 'DERIVED' }],
      derivedByDate: { '2025-01-10': derived(0, 800) },
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(0);
    expect(ctx.transaction).not.toHaveBeenCalled();
  });

  it('非事件日的 MANUAL 记录绝不被误删', async () => {
    const ctx = setup({
      eventDates: [],
      // 用户手工录入的记录：非事件日、派生值为 0，但 source=MANUAL
      snapshotRows: [{ date: '2025-01-10', source: 'MANUAL' }],
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(0);
    expect(ctx.transaction).not.toHaveBeenCalled();
    // MANUAL 日仍参与净值级联，且行仍在表内
    expect(ctx.calculatedDates).toContain('2025-01-10');
    expect(ctx.currentRows()).toEqual([
      { date: '2025-01-10', source: 'MANUAL' },
    ]);
  });

  it('无候选（全部快照都在事件日）→ 不发起派生批量计算，也不发起清理事务', async () => {
    const ctx = setup({
      eventDates: ['2025-01-05', '2025-01-06'],
      snapshotRows: [
        { date: '2025-01-05', source: 'DERIVED' },
        { date: '2025-01-06', source: 'DERIVED' },
      ],
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(0);
    expect(ctx.computeDerivedBatch).not.toHaveBeenCalled();
    expect(ctx.transaction).not.toHaveBeenCalled();
  });

  it('多个孤儿日一次性清理，且只发起 1 次批量派生（无 N+1）', async () => {
    const ctx = setup({
      eventDates: ['2025-01-05'],
      snapshotRows: [
        { date: '2025-01-05', source: 'DERIVED' },
        { date: '2025-01-10', source: 'DERIVED' },
        { date: '2025-01-11', source: 'DERIVED' },
        { date: '2025-01-12', source: 'DERIVED' },
      ],
    });

    const result = await ctx.service.recalculateRange(PORTFOLIO_ID, START, END);

    expect(result.cleanedOrphanDays).toBe(3);
    expect(ctx.computeDerivedBatch).toHaveBeenCalledTimes(1);
    expect(ctx.assetSnapshotDeleteMany).toHaveBeenCalledWith({
      where: {
        portfolioId: PORTFOLIO_ID,
        date: { in: [d('2025-01-10'), d('2025-01-11'), d('2025-01-12')] },
        source: 'DERIVED',
      },
    });
  });
});
