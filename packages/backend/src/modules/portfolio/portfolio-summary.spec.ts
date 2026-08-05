/**
 * PortfolioService.getSummary — cumulativeReturnRate / xirr 补列 验收测试（Q-4 甲 · 阶段 B）
 *
 * 验证点（对齐 docs/holdings-overview-alignment.md §9 决策 Q-4 / 清单 DASH-P1-01）：
 * - cumulativeReturnRate = cumulativeNav - 1，8 位小数字符串；无 DailyNav → null
 * - 与 OverviewService.totalReturnRate **逐位一致**（同口径同精度，跨服务不得漂移）
 * - xirr 取该组合**最新一条** DailyXirr 的 xirrValue；
 *   无记录 / xirrValue 为 null → null；**恰为 0 → '0.00000000' 不得塌成 null**
 * - 多组合（≥5）**无 N+1**：dailyXirr 只查 1 次（DISTINCT ON），不随组合数增长
 * - Decimal 精度不丢（不经过 JS float）
 *
 * 说明：prisma 与 recalculationService 全部 mock，不触库。
 */

import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { PortfolioService } from './portfolio.service';
import { OverviewService } from '../overview/overview.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RecalculationService } from '../recalculation/recalculation.service';
import type { HoldingDerivationService } from '../holding/holding-derivation.service';

const USER_ID = 'user-1';

interface PortfolioSeed {
  id: string;
  name?: string;
  /** 累计净值；null = 无 DailyNav */
  cumulativeNav?: string | null;
  yearNav?: string | null;
  /** 最新 XIRR 值；null = 记录存在但值为 null；undefined = 无 DailyXirr 记录 */
  xirrValue?: string | null;
  totalAsset?: string | null;
}

function makeSeeds(n: number): PortfolioSeed[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `pf-${i + 1}`,
    name: `组合${i + 1}`,
    cumulativeNav: '1.10000000',
    yearNav: '1.05000000',
    xirrValue: '0.08210000',
    totalAsset: '10000.00',
  }));
}

function createService(seeds: PortfolioSeed[]) {
  const portfolioFindMany = jest.fn(async () =>
    seeds.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      description: null,
      baseDate: null,
      currency: 'CNY',
      archivedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      snapshots:
        s.totalAsset != null
          ? [
              {
                totalAsset: new Prisma.Decimal(s.totalAsset),
                date: new Date('2026-06-15T00:00:00.000Z'),
              },
            ]
          : [],
      securityTrades: [],
    })),
  );

  // 每组合一次（既有实现的持仓数推导循环）
  const securityTradeFindMany = jest.fn(async () => []);

  const dailyNavFindMany = jest.fn(async () =>
    seeds
      .filter((s) => s.cumulativeNav != null)
      .map((s) => ({
        portfolioId: s.id,
        cumulativeNav: new Prisma.Decimal(s.cumulativeNav as string),
        yearNav: new Prisma.Decimal(s.yearNav ?? '1'),
      })),
  );

  // 显式入参类型：使 mock.calls[0][0] 可被断言（否则被推断为空元组）
  const dailyXirrFindMany = jest.fn(async (_args?: Record<string, unknown>) =>
    seeds
      .filter((s) => s.xirrValue !== undefined)
      .map((s) => ({
        portfolioId: s.id,
        xirrValue:
          s.xirrValue === null ? null : new Prisma.Decimal(s.xirrValue as string),
      })),
  );

  const cashFlowGroupBy = jest.fn(async () => []);

  const prisma = {
    portfolio: { findMany: portfolioFindMany },
    securityTrade: { findMany: securityTradeFindMany },
    dailyNav: { findMany: dailyNavFindMany },
    dailyXirr: { findMany: dailyXirrFindMany },
    cashFlow: { groupBy: cashFlowGroupBy },
  };

  const service = new PortfolioService(
    prisma as unknown as PrismaService,
    {} as RecalculationService,
  );

  return { service, dailyXirrFindMany, dailyNavFindMany, securityTradeFindMany };
}

// ============================================================
// 1. cumulativeReturnRate = cumulativeNav - 1
// ============================================================

describe('getSummary — cumulativeReturnRate（Q-4 甲）', () => {
  it('返回 8 位小数字符串，等于 cumulativeNav - 1', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.23450000', xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeReturnRate).toBe('0.23450000');
  });

  it('亏损组合为负值（cumulativeNav < 1）', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '0.87650000', xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeReturnRate).toBe('-0.12350000');
  });

  it('净值恰为 1 → "0.00000000"（不塌成 null / 不丢符号位）', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.00000000', xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeReturnRate).toBe('0.00000000');
  });

  it('无 DailyNav → null（前端渲染「—」，禁止渲染 0）', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: null, xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeReturnRate).toBeNull();
    expect(row.cumulativeNav).toBeNull();
  });

  it('高精度净值不经 JS float 丢位（Decimal 直算）', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.00000001', xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeReturnRate).toBe('0.00000001');
  });

  it('与既有 yearReturnRate 精度一致（同为 8 位小数）', async () => {
    const { service } = createService([
      {
        id: 'pf-1',
        cumulativeNav: '1.20000000',
        yearNav: '1.05000000',
        xirrValue: undefined,
      },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeReturnRate?.split('.')[1]).toHaveLength(8);
    expect(row.yearReturnRate?.split('.')[1]).toHaveLength(8);
  });
});

// ============================================================
// 2. 与 overview.totalReturnRate 跨服务逐位一致
// ============================================================

describe('getSummary.cumulativeReturnRate ↔ overview.totalReturnRate 口径一致性', () => {
  /** 用同一份 cumulativeNav 跑 OverviewService，取 totalReturnRate */
  async function overviewRate(cumulativeNav: string): Promise<string> {
    const prisma = {
      portfolio: { findFirst: jest.fn(async () => ({ id: 'pf-1' })) },
      assetSnapshot: { findFirst: jest.fn(async () => null) },
      dailyNav: {
        findFirst: jest.fn(async () => ({
          cumulativeNav: new Prisma.Decimal(cumulativeNav),
          yearNav: new Prisma.Decimal('1'),
          date: new Date('2026-06-15T00:00:00.000Z'),
        })),
      },
      dailyXirr: { findFirst: jest.fn(async () => null) },
      cashFlow: { findMany: jest.fn(async () => []) },
    };
    const overview = new OverviewService(
      prisma as unknown as PrismaService,
      { derive: jest.fn(async () => []) } as unknown as HoldingDerivationService,
    );
    const res = await overview.getOverview('pf-1', USER_ID);
    return res.totalReturnRate;
  }

  const CASES = [
    '1.23450000',
    '0.87650000',
    '1.00000000',
    '2.50000000',
    '1.00000001',
    '1.33333333',
    '0.00500000',
    '9.87654321',
  ];

  it.each(CASES)(
    'cumulativeNav=%s：summary.cumulativeReturnRate 与 overview.totalReturnRate 逐位相同',
    async (nav) => {
      const { service } = createService([
        { id: 'pf-1', cumulativeNav: nav, xirrValue: undefined },
      ]);

      const [row] = await service.getSummary(USER_ID);
      const fromOverview = await overviewRate(nav);

      expect(row.cumulativeReturnRate).toBe(fromOverview);
    },
  );
});

// ============================================================
// 3. xirr 取最新一条 DailyXirr
// ============================================================

describe('getSummary — xirr（Q-4 甲）', () => {
  it('有 XIRR 记录 → 8 位小数字符串', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.1', xirrValue: '0.08210000' },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.xirr).toBe('0.08210000');
  });

  it('负 XIRR 保留符号', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.1', xirrValue: '-0.15300000' },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.xirr).toBe('-0.15300000');
  });

  it('【关键】XIRR 恰为 0 → "0.00000000"，不得因真值判断塌成 null', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.1', xirrValue: '0' },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.xirr).toBe('0.00000000');
    expect(row.xirr).not.toBeNull();
  });

  it('记录存在但 xirrValue 为 null（数据不足无法求解）→ null', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.1', xirrValue: null },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.xirr).toBeNull();
  });

  it('无任何 DailyXirr 记录 → null', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.1', xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.xirr).toBeNull();
  });

  it('查询必须按 (portfolioId asc, date desc) + distinct 取「最新一条」', async () => {
    const { service, dailyXirrFindMany } = createService(makeSeeds(3));

    await service.getSummary(USER_ID);

    const args = dailyXirrFindMany.mock.calls[0]?.[0] as unknown as {
      orderBy: Array<Record<string, string>>;
      distinct: string[];
      where: { portfolioId: { in: string[] } };
    };
    expect(args.distinct).toEqual(['portfolioId']);
    expect(args.orderBy).toEqual([
      { portfolioId: 'asc' },
      { date: 'desc' },
    ]);
    expect(args.where.portfolioId.in).toEqual(['pf-1', 'pf-2', 'pf-3']);
  });

  it('多组合各取各的 XIRR，不串号', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: '1.1', xirrValue: '0.01000000' },
      { id: 'pf-2', cumulativeNav: '1.2', xirrValue: '0.02000000' },
      { id: 'pf-3', cumulativeNav: '1.3', xirrValue: undefined },
    ]);

    const rows = await service.getSummary(USER_ID);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get('pf-1')?.xirr).toBe('0.01000000');
    expect(byId.get('pf-2')?.xirr).toBe('0.02000000');
    expect(byId.get('pf-3')?.xirr).toBeNull();
  });
});

// ============================================================
// 4. 无 N+1（Q-4 甲 性能约束）
// ============================================================

describe('getSummary — XIRR 查询无 N+1', () => {
  it('1 个组合：dailyXirr 查询 1 次', async () => {
    const { service, dailyXirrFindMany } = createService(makeSeeds(1));

    await service.getSummary(USER_ID);

    expect(dailyXirrFindMany).toHaveBeenCalledTimes(1);
  });

  it('【关键】5 个组合：dailyXirr 仍只查 1 次（不随组合数线性增长）', async () => {
    const { service, dailyXirrFindMany } = createService(makeSeeds(5));

    const rows = await service.getSummary(USER_ID);

    expect(rows).toHaveLength(5);
    expect(dailyXirrFindMany).toHaveBeenCalledTimes(1);
  });

  it('【关键】20 个组合：dailyXirr 查询次数与 5 个组合时相同（恒为 1）', async () => {
    const { service, dailyXirrFindMany } = createService(makeSeeds(20));

    await service.getSummary(USER_ID);

    expect(dailyXirrFindMany).toHaveBeenCalledTimes(1);
  });

  it('XIRR 查询次数与 DailyNav 查询次数同量级（复刻 latestNavs 范式）', async () => {
    const { service, dailyXirrFindMany, dailyNavFindMany } =
      createService(makeSeeds(8));

    await service.getSummary(USER_ID);

    expect(dailyXirrFindMany.mock.calls.length).toBe(
      dailyNavFindMany.mock.calls.length,
    );
  });

  it('【遗留记录·非阶段B引入】持仓数推导仍是 per-portfolio 循环（既有 N+1，与 Q-4 甲 无关）', async () => {
    const { service, securityTradeFindMany, dailyXirrFindMany } =
      createService(makeSeeds(5));

    await service.getSummary(USER_ID);

    // XIRR / NAV 已批量化（1 次）；securityTrade 仍按组合数发起，属既有实现，
    // 本用例仅作现状锚定：若后续优化为批量，此断言应随之更新。
    expect(dailyXirrFindMany).toHaveBeenCalledTimes(1);
    expect(securityTradeFindMany).toHaveBeenCalledTimes(5);
  });

  it('无组合时不发起 XIRR 查询（空守卫生效）', async () => {
    const { service, dailyXirrFindMany } = createService([]);

    const rows = await service.getSummary(USER_ID);

    expect(rows).toEqual([]);
    expect(dailyXirrFindMany).not.toHaveBeenCalled();
  });

  it('5 组合响应耗时在验收阈值内（<800ms，mock 层仅测编排开销）', async () => {
    const { service } = createService(makeSeeds(5));

    const t0 = Date.now();
    await service.getSummary(USER_ID);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(800);
  });
});

// ============================================================
// 5. 既有字段无回归
// ============================================================

describe('getSummary — 既有字段无回归', () => {
  it('新增两列不影响 cumulativeNav / yearReturnRate / netInvested / floatingProfit', async () => {
    const { service } = createService([
      {
        id: 'pf-1',
        cumulativeNav: '1.23456700',
        yearNav: '1.05000000',
        xirrValue: '0.08210000',
        totalAsset: '10000.00',
      },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.cumulativeNav).toBe('1.234567');
    expect(row.yearReturnRate).toBe('0.05000000');
    expect(row.netInvested).toBe('0.00');
    expect(row.floatingProfit).toBe('10000.00');
  });

  it('无快照组合：floatingProfit 仍为 null，新增两列独立判空', async () => {
    const { service } = createService([
      {
        id: 'pf-1',
        cumulativeNav: '1.1',
        xirrValue: '0.05',
        totalAsset: null,
      },
    ]);

    const [row] = await service.getSummary(USER_ID);

    expect(row.floatingProfit).toBeNull();
    expect(row.cumulativeReturnRate).toBe('0.10000000');
    expect(row.xirr).toBe('0.05000000');
  });

  it('两个新字段始终存在于响应（即便为 null，JSON 序列化后仍在）', async () => {
    const { service } = createService([
      { id: 'pf-1', cumulativeNav: null, xirrValue: undefined },
    ]);

    const [row] = await service.getSummary(USER_ID);
    const wire = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(wire, 'cumulativeReturnRate')).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(wire, 'xirr')).toBe(true);
    expect(wire.cumulativeReturnRate).toBeNull();
    expect(wire.xirr).toBeNull();
  });
});
