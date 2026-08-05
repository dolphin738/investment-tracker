/**
 * OverviewService — `latestSource` 快照来源透出 验收测试（Q-2 乙 · 阶段 B）
 *
 * 验证点（对齐 docs/holdings-overview-alignment.md §9 决策 Q-2）：
 * - 响应必须**始终包含** latestSource 字段（供概览页「✋手工」徽标判定）
 * - 最新快照 source=MANUAL → 'MANUAL'；DERIVED → 'DERIVED'
 * - **组合无任何快照 → 必须是 null**（不是 undefined、不是 ''）
 * - 取的是「最新一条」快照的 source（orderBy date desc），不是任意一条
 * - assetSnapshot 查询的 select 必须含 source:true，否则字段恒为 undefined
 * - 不额外增加查询次数（避免为徽标多打一次 snapshots 请求）
 *
 * 说明：prisma 与 holdingDerivationService 全部 mock，不触库。
 */

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { Prisma, SnapshotSource as PrismaSnapshotSource } from '@prisma/client';
import { SnapshotSource } from '@investment-tracker/shared';
import { OverviewService } from './overview.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { HoldingDerivationService } from '../holding/holding-derivation.service';

const USER_ID = 'user-1';
const PORTFOLIO_ID = 'pf-1';

interface SnapshotRow {
  totalAsset: Prisma.Decimal;
  date: Date;
  source: string;
}

/** 构造一条资产快照行（Prisma select 结果的最小子集） */
function makeSnapshot(
  source: string,
  date = '2026-06-15',
  totalAsset = '123456.78',
): SnapshotRow {
  return {
    totalAsset: new Prisma.Decimal(totalAsset),
    date: new Date(`${date}T00:00:00.000Z`),
    source,
  };
}

function createService(options: {
  snapshot?: SnapshotRow | null;
  nav?: { cumulativeNav: Prisma.Decimal; yearNav: Prisma.Decimal; date: Date } | null;
}) {
  const { snapshot = null, nav = null } = options;

  // 显式声明入参类型，使 mock.calls[0][0] 可被断言（否则被推断为空元组）
  const assetSnapshotFindFirst = jest.fn(
    async (_args?: Record<string, unknown>) => snapshot,
  );
  const dailyNavFindFirst = jest.fn(
    async (_args?: Record<string, unknown>) => nav,
  );
  const dailyXirrFindFirst = jest.fn(
    async (_args?: Record<string, unknown>) => null,
  );
  const cashFlowFindMany = jest.fn(
    async (_args?: Record<string, unknown>) => [],
  );
  const portfolioFindFirst = jest.fn(
    async (_args?: Record<string, unknown>): Promise<{ id: string } | null> => ({
      id: PORTFOLIO_ID,
    }),
  );

  const prisma = {
    portfolio: { findFirst: portfolioFindFirst },
    assetSnapshot: { findFirst: assetSnapshotFindFirst },
    dailyNav: { findFirst: dailyNavFindFirst },
    dailyXirr: { findFirst: dailyXirrFindFirst },
    cashFlow: { findMany: cashFlowFindMany },
  };

  const derive = jest.fn(async () => []);
  const derivation = { derive } as unknown as HoldingDerivationService;

  const service = new OverviewService(
    prisma as unknown as PrismaService,
    derivation,
  );

  return {
    service,
    assetSnapshotFindFirst,
    cashFlowFindMany,
    portfolioFindFirst,
    derive,
  };
}

// ============================================================
// 1. 有快照：source 原样透出
// ============================================================

describe('OverviewService.getOverview — latestSource 透出（Q-2 乙）', () => {
  it('最新快照 source=MANUAL → latestSource === "MANUAL"', async () => {
    const { service } = createService({ snapshot: makeSnapshot('MANUAL') });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.latestSource).toBe('MANUAL');
  });

  it('最新快照 source=DERIVED → latestSource === "DERIVED"', async () => {
    const { service } = createService({ snapshot: makeSnapshot('DERIVED') });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.latestSource).toBe('DERIVED');
  });

  it('取值必须落在 shared SnapshotSource 枚举内（前后端同源）', async () => {
    const allowed = Object.values(SnapshotSource);

    for (const src of allowed) {
      const { service } = createService({ snapshot: makeSnapshot(src) });
      const res = await service.getOverview(PORTFOLIO_ID, USER_ID);
      expect(allowed).toContain(res.latestSource as string);
    }
  });

  it('latestSource 与 latestDate 同源于同一条最新快照', async () => {
    const { service } = createService({
      snapshot: makeSnapshot('MANUAL', '2026-06-15'),
    });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.latestDate).toBe('2026-06-15');
    expect(res.latestSource).toBe('MANUAL');
  });
});

// ============================================================
// 2. 无快照：必须严格为 null
// ============================================================

describe('OverviewService.getOverview — 无快照时 latestSource 语义', () => {
  it('【关键】组合无任何快照 → latestSource 必须是 null', async () => {
    const { service } = createService({ snapshot: null });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.latestSource).toBeNull();
  });

  it('【关键】无快照时不得为 undefined（字段必须存在于响应体，JSON 序列化后仍在）', async () => {
    const { service } = createService({ snapshot: null });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect('latestSource' in res).toBe(true);
    expect(res.latestSource).not.toBeUndefined();
    // 经过 JSON 序列化（真实 HTTP 响应路径）后字段依然存在且为 null
    const wire = JSON.parse(JSON.stringify(res)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(wire, 'latestSource')).toBe(
      true,
    );
    expect(wire.latestSource).toBeNull();
  });

  it('【关键】无快照时不得为空串（前端 === "MANUAL" 判定不能被 "" 干扰）', async () => {
    const { service } = createService({ snapshot: null });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.latestSource).not.toBe('');
  });

  it('无快照但有净值时，latestSource 仍为 null（不从 DailyNav 臆造来源）', async () => {
    const { service } = createService({
      snapshot: null,
      nav: {
        cumulativeNav: new Prisma.Decimal('1.2345'),
        yearNav: new Prisma.Decimal('1.05'),
        date: new Date('2026-06-15T00:00:00.000Z'),
      },
    });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.latestDate).toBe('2026-06-15');
    expect(res.latestSource).toBeNull();
  });
});

// ============================================================
// 3. 查询实现约束
// ============================================================

describe('OverviewService.getOverview — latestSource 查询实现', () => {
  it('assetSnapshot 查询的 select 必须包含 source:true（否则字段恒 undefined）', async () => {
    const { service, assetSnapshotFindFirst } = createService({
      snapshot: makeSnapshot('MANUAL'),
    });

    await service.getOverview(PORTFOLIO_ID, USER_ID);

    const args = assetSnapshotFindFirst.mock.calls[0]?.[0] as unknown as {
      select: Record<string, boolean>;
      orderBy: Record<string, string>;
    };
    expect(args.select.source).toBe(true);
    // 仍按日期倒序取最新一条
    expect(args.orderBy).toEqual({ date: 'desc' });
  });

  it('不因新增字段而多打一次快照查询（仍只查 1 次 assetSnapshot）', async () => {
    const { service, assetSnapshotFindFirst } = createService({
      snapshot: makeSnapshot('MANUAL'),
    });

    await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(assetSnapshotFindFirst).toHaveBeenCalledTimes(1);
  });

  it('数据隔离未被破坏：非本人组合仍抛 404，不泄露 latestSource', async () => {
    const { service, portfolioFindFirst } = createService({
      snapshot: makeSnapshot('MANUAL'),
    });
    portfolioFindFirst.mockResolvedValueOnce(null);

    await expect(
      service.getOverview(PORTFOLIO_ID, 'other-user'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('【防漂移】shared SnapshotSource 与 Prisma schema 枚举一致（MANUAL/DERIVED）', () => {
    expect(Object.values(SnapshotSource).slice().sort()).toEqual(
      Object.values(PrismaSnapshotSource).slice().sort(),
    );
  });

  it('原有字段未回归：totalAsset / cumulativeNav / totalReturnRate 照常', async () => {
    const { service } = createService({
      snapshot: makeSnapshot('DERIVED', '2026-06-15', '123456.78'),
      nav: {
        cumulativeNav: new Prisma.Decimal('1.2345'),
        yearNav: new Prisma.Decimal('1.05'),
        date: new Date('2026-06-15T00:00:00.000Z'),
      },
    });

    const res = await service.getOverview(PORTFOLIO_ID, USER_ID);

    expect(res.totalAsset).toBe('123456.78');
    expect(res.cumulativeNav).toBe('1.234500');
    expect(res.totalReturnRate).toBe('0.23450000');
    expect(res.yearReturnRate).toBe('0.05000000');
    expect(res.latestSource).toBe('DERIVED');
  });
});
