/**
 * SnapshotService — derivedTotalAsset 回填（AL-054 · 决策 Q-1 甲）验收测试
 *
 * 验证点：
 * - 列表每条响应都含 `derivedTotalAsset` 字段
 * - MANUAL 行 → 走 `AssetValuationService.computeDerivedBatch` 实时值
 * - DERIVED 行 → 直接等于 totalAsset（不查库）
 * - 🔴 N 条 MANUAL 行只触发 **1 次** computeDerivedBatch（N+1 规避）
 * - 计算异常 → 相关行 derivedTotalAsset 降级为 null，列表仍正常返回（200，不抛错）
 *
 * prisma / recalculationService / assetValuation 全部 mock，不触库。
 */

import 'reflect-metadata';
import { Prisma, SnapshotSource } from '@prisma/client';
import { SnapshotService } from './snapshot.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RecalculationService } from '../recalculation/recalculation.service';
import type { AssetValuationService } from '../valuation/asset-valuation.service';
import type { SnapshotQueryDto } from './dto/upsert-snapshot.dto';

const USER_ID = 'user-1';
const PORTFOLIO_ID = 'pf-1';

interface RowSpec {
  date: string;
  source: string;
  totalAsset: string;
}

/** 构造一条 Prisma assetSnapshot 行的最小子集（toResponse 所需字段） */
function makeRow(spec: RowSpec): Prisma.AssetSnapshotGetPayload<{
  select: {
    id: true;
    portfolioId: true;
    date: true;
    totalAsset: true;
    marketValue: true;
    cashBalance: true;
    source: true;
    valuationFlag: true;
    note: true;
    recordedAt: true;
    createdAt: true;
    updatedAt: true;
  };
}> {
  return {
    id: `snap-${spec.date}`,
    portfolioId: PORTFOLIO_ID,
    date: new Date(`${spec.date}T00:00:00.000Z`),
    totalAsset: new Prisma.Decimal(spec.totalAsset),
    marketValue: new Prisma.Decimal(spec.totalAsset),
    cashBalance: new Prisma.Decimal('0'),
    source: spec.source as SnapshotSource,
    valuationFlag: spec.source === 'MANUAL' ? 'MANUAL_INPUT' : 'EXACT',
    note: null,
    recordedAt: new Date(`${spec.date}T01:00:00.000Z`),
    createdAt: new Date(`${spec.date}T01:00:00.000Z`),
    updatedAt: new Date(`${spec.date}T01:00:00.000Z`),
  } as never;
}

function createService(options: {
  rows: ReturnType<typeof makeRow>[];
  computeBatch?: jest.Mock;
  findOneRow?: ReturnType<typeof makeRow> | null;
}) {
  const { rows, computeBatch, findOneRow = null } = options;

  const assetSnapshotFindMany = jest.fn().mockResolvedValue(rows);
  const assetSnapshotCount = jest.fn().mockResolvedValue(rows.length);
  const assetSnapshotFindUnique = jest.fn().mockResolvedValue(findOneRow);

  const prisma = {
    portfolio: { findFirst: jest.fn().mockResolvedValue({ id: PORTFOLIO_ID }) },
    assetSnapshot: {
      findMany: assetSnapshotFindMany,
      count: assetSnapshotCount,
      findUnique: assetSnapshotFindUnique,
    },
  };

  const recalculationService = {
    recalculateNavRange: jest.fn().mockResolvedValue(undefined),
  } as unknown as RecalculationService;

  const assetValuation = {
    computeDerivedBatch:
      computeBatch ??
      jest.fn().mockResolvedValue(new Map<string, { totalAsset: number }>()),
  } as unknown as AssetValuationService;

  const service = new SnapshotService(
    prisma as unknown as PrismaService,
    recalculationService,
    assetValuation,
  );

  return {
    service,
    assetSnapshotFindMany,
    assetSnapshotFindUnique,
    assetValuation,
  };
}

const query = {} as SnapshotQueryDto;

describe('SnapshotService.findAll — derivedTotalAsset 回填', () => {
  it('每条响应都含 derivedTotalAsset 字段', async () => {
    const { service } = createService({
      rows: [makeRow({ date: '2026-01-01', source: 'MANUAL', totalAsset: '100' })],
    });

    const res = await service.findAll(USER_ID, PORTFOLIO_ID, query);

    expect(res.items[0]).toHaveProperty('derivedTotalAsset');
  });

  it('【关键】N 条 MANUAL 行只触发 1 次 computeDerivedBatch（N+1 规避）', async () => {
    const rows = [
      makeRow({ date: '2026-01-01', source: 'MANUAL', totalAsset: '100' }),
      makeRow({ date: '2026-01-02', source: 'MANUAL', totalAsset: '200' }),
      makeRow({ date: '2026-01-03', source: 'MANUAL', totalAsset: '300' }),
    ];
    const computeBatch = jest.fn().mockResolvedValue(
      new Map<string, { totalAsset: number }>([
        ['2026-01-01', { totalAsset: 123.45 }],
        ['2026-01-02', { totalAsset: 200 }],
        ['2026-01-03', { totalAsset: 300.5 }],
      ]),
    );
    const { service, assetValuation } = createService({ rows, computeBatch });

    await service.findAll(USER_ID, PORTFOLIO_ID, query);

    expect(assetValuation.computeDerivedBatch).toHaveBeenCalledTimes(1);
  });

  it('MANUAL 行的 derivedTotalAsset = computeDerivedBatch 实时值（2 位小数）', async () => {
    const rows = [
      makeRow({ date: '2026-01-01', source: 'MANUAL', totalAsset: '100' }),
      makeRow({ date: '2026-01-02', source: 'MANUAL', totalAsset: '200' }),
    ];
    const computeBatch = jest.fn().mockResolvedValue(
      new Map<string, { totalAsset: number }>([
        ['2026-01-01', { totalAsset: 123.456 }],
        ['2026-01-02', { totalAsset: 200 }],
      ]),
    );
    const { service } = createService({ rows, computeBatch });

    const res = await service.findAll(USER_ID, PORTFOLIO_ID, query);

    expect(res.items[0].derivedTotalAsset).toBe('123.46');
    expect(res.items[1].derivedTotalAsset).toBe('200.00');
  });

  it('DERIVED 行 derivedTotalAsset === totalAsset，且不触发 computeDerivedBatch', async () => {
    const rows = [
      makeRow({ date: '2026-01-01', source: 'DERIVED', totalAsset: '1234.56' }),
      makeRow({ date: '2026-01-02', source: 'DERIVED', totalAsset: '789.00' }),
    ];
    const { service, assetValuation } = createService({ rows });

    const res = await service.findAll(USER_ID, PORTFOLIO_ID, query);

    expect(assetValuation.computeDerivedBatch).not.toHaveBeenCalled();
    // DERIVED 行：派生值 === 落库 totalAsset（Decimal.toString 去尾零，'789.00'→'789'）
    expect(res.items[0].derivedTotalAsset).toBe(res.items[0].totalAsset);
    expect(res.items[1].derivedTotalAsset).toBe(res.items[1].totalAsset);
    expect(res.items[0].derivedTotalAsset).toBe('1234.56');
    expect(res.items[1].derivedTotalAsset).toBe('789');
  });

  it('【关键】computeDerivedBatch 抛错 → MANUAL 行降级 null，列表仍正常返回（不抛错）', async () => {
    const rows = [
      makeRow({ date: '2026-01-01', source: 'MANUAL', totalAsset: '100' }),
      makeRow({ date: '2026-01-02', source: 'MANUAL', totalAsset: '200' }),
    ];
    const computeBatch = jest
      .fn()
      .mockRejectedValue(new Error('derived computation failed'));
    const { service, assetValuation } = createService({ rows, computeBatch });

    // 必须 resolve，不能抛错（列表照常 200）
    const res = await service.findAll(USER_ID, PORTFOLIO_ID, query);

    expect(assetValuation.computeDerivedBatch).toHaveBeenCalledTimes(1);
    expect(res.items[0].derivedTotalAsset).toBeNull();
    expect(res.items[1].derivedTotalAsset).toBeNull();
    expect(res.items).toHaveLength(2);
  });

  it('MANUAL 行 mix DERIVED：仅 MANUAL 行触发一次批量计算', async () => {
    const rows = [
      makeRow({ date: '2026-01-01', source: 'DERIVED', totalAsset: '100' }),
      makeRow({ date: '2026-01-02', source: 'MANUAL', totalAsset: '200' }),
      makeRow({ date: '2026-01-03', source: 'MANUAL', totalAsset: '300' }),
    ];
    const computeBatch = jest.fn().mockResolvedValue(
      new Map<string, { totalAsset: number }>([
        ['2026-01-02', { totalAsset: 250 }],
        ['2026-01-03', { totalAsset: 350 }],
      ]),
    );
    const { service, assetValuation } = createService({ rows, computeBatch });

    const res = await service.findAll(USER_ID, PORTFOLIO_ID, query);

    expect(assetValuation.computeDerivedBatch).toHaveBeenCalledTimes(1);
    expect(res.items[0].derivedTotalAsset).toBe('100'); // DERIVED == totalAsset
    expect(res.items[1].derivedTotalAsset).toBe('250.00');
    expect(res.items[2].derivedTotalAsset).toBe('350.00');
  });
});

describe('SnapshotService.findOne — A3 单条端点（GET /snapshots/:date）', () => {
  it('返回单条（含 derivedTotalAsset），MANUAL 行走 computeDerivedBatch', async () => {
    const row = makeRow({
      date: '2026-01-01',
      source: 'MANUAL',
      totalAsset: '100',
    });
    const computeBatch = jest.fn().mockResolvedValue(
      new Map<string, { totalAsset: number }>([
        ['2026-01-01', { totalAsset: 123.45 }],
      ]),
    );
    const { service, assetValuation, assetSnapshotFindUnique } = createService({
      rows: [],
      computeBatch,
      findOneRow: row,
    });

    const res = await service.findOne(USER_ID, PORTFOLIO_ID, '2026-01-01');

    expect(assetSnapshotFindUnique).toHaveBeenCalledWith({
      where: {
        portfolioId_date: {
          portfolioId: PORTFOLIO_ID,
          date: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
    });
    expect(assetValuation.computeDerivedBatch).toHaveBeenCalledTimes(1);
    expect(res.date).toBe('2026-01-01');
    expect(res.derivedTotalAsset).toBe('123.45');
  });

  it('DERIVED 行 derivedTotalAsset === totalAsset，不触发计算', async () => {
    const row = makeRow({
      date: '2026-01-02',
      source: 'DERIVED',
      totalAsset: '789.00',
    });
    const { service, assetValuation } = createService({
      rows: [],
      findOneRow: row,
    });

    const res = await service.findOne(USER_ID, PORTFOLIO_ID, '2026-01-02');

    expect(assetValuation.computeDerivedBatch).not.toHaveBeenCalled();
    expect(res.derivedTotalAsset).toBe('789');
  });

  it('该日无记录 → 抛 NotFoundException（404 语义）', async () => {
    const { service, assetSnapshotFindUnique } = createService({
      rows: [],
      findOneRow: null,
    });

    await expect(
      service.findOne(USER_ID, PORTFOLIO_ID, '2026-01-03'),
    ).rejects.toThrow('资产快照不存在');
    expect(assetSnapshotFindUnique).toHaveBeenCalledTimes(1);
  });

  it('非法日期格式 → 抛 BadRequestException（400），不查库', async () => {
    const { service, assetSnapshotFindUnique } = createService({ rows: [] });

    await expect(
      service.findOne(USER_ID, PORTFOLIO_ID, '2026/01/01'),
    ).rejects.toThrow('无效日期参数');
    expect(assetSnapshotFindUnique).not.toHaveBeenCalled();
  });
});
