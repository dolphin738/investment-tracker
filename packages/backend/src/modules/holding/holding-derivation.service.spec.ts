/**
 * HoldingDerivationService — 持仓推导回归测试（方案B · 交易明细法）
 *
 * 重点覆盖：
 * 1. 🔴 raw query 类型匹配回归（Bug：`text = uuid` 42883）：
 *    `security_prices.security_id` 是 text 列（Prisma `String @map("security_id")`），
 *    参数必须用 `ANY($2::text[])`，误用 `::uuid[]` 会在真实 PG 上报
 *    `operator does not exist: text = uuid`，导致持仓/费用不落库。
 *    这里锁 SQL 字符串与传参形状，防止回退。
 * 2. `$1`（portfolio_id，text）与 `$3::date`（asOf 为 @db.Date）的参数匹配。
 * 3. 移动加权平均回放 + 价格向前沿用（EXACT / COST_BASED 两条估值路径）。
 *
 * prisma 全部 mock，不触库（与 holding.controller.spec.ts 同范式）。
 */

import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { SecuritySide } from '@prisma/client';
import { HoldingDerivationService } from './holding-derivation.service';
import type { PrismaService } from '../../prisma/prisma.service';

const PORTFOLIO_ID = 'pf-1';

/** YYYY-MM-DD → UTC 午夜 Date（与 @db.Date 口径一致） */
function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** 构造一条交易记录（Prisma 实体形状，只填推导关心的字段） */
function trade(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tr-1',
    portfolioId: PORTFOLIO_ID,
    securityId: 'sec-1',
    date: d('2026-01-10'),
    side: SecuritySide.BUY_SEC,
    quantity: { toString: () => '100' },
    price: { toString: () => '10' },
    fee: { toString: () => '5' },
    note: null,
    createdAt: new Date('2026-01-10T00:00:00.000Z'),
    updatedAt: new Date('2026-01-10T00:00:00.000Z'),
    security: { id: 'sec-1', code: '600519', name: '贵州茅台', type: 'STOCK' },
    ...overrides,
  };
}

/** 构造一条价格行（raw query 返回形状：price / asOf 为 text） */
function priceRow(overrides: Partial<Record<string, string>> = {}) {
  return {
    security_id: 'sec-1',
    price: '12.500000',
    asOf: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

interface SetupResult {
  service: HoldingDerivationService;
  prisma: {
    securityTrade: { findMany: jest.Mock };
    $queryRawUnsafe: jest.Mock;
  };
  priceQueryArgs: () => { sql: string; params: unknown[] };
}

/**
 * 构造被测服务：mock prisma，捕获 raw query 的 SQL 与参数。
 */
function setup(trades: unknown[], priceRows: unknown[]): SetupResult {
  const securityTradeFindMany = jest.fn().mockResolvedValue(trades);
  const queryRawUnsafe = jest.fn().mockResolvedValue(priceRows);

  const prisma = {
    securityTrade: { findMany: securityTradeFindMany },
    $queryRawUnsafe: queryRawUnsafe,
  };

  const service = new HoldingDerivationService(
    prisma as unknown as PrismaService,
  );

  /** 最近一次 raw query 调用的 (sql, 参数列表) */
  const priceQueryArgs = () => {
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    return { sql, params };
  };

  return { service, prisma, priceQueryArgs };
}

describe('HoldingDerivationService.deriveBatch — raw query 类型匹配（Bug 回归）', () => {
  it('🔴 价格查询用 ANY($2::text[]) 而非 ::uuid[]（security_id 是 text 列）', async () => {
    const ctx = setup(
      [trade()],
      [priceRow()],
    );

    await ctx.service.deriveBatch(PORTFOLIO_ID, [d('2026-06-30')]);

    const { sql, params } = ctx.priceQueryArgs();
    expect(sql).toContain('ANY($2::text[])');
    expect(sql).not.toContain('::uuid[]');
    // $1 portfolio_id：text = text，无强转
    expect(sql).toContain('sp.portfolio_id = $1');
    // $3::date 与 asOf（@db.Date）匹配
    expect(sql).toContain('sp."asOf" <= $3::date');
    // 参数顺序：portfolioId → securityIds[] → maxDate
    expect(params[0]).toBe(PORTFOLIO_ID);
    expect(params[1]).toEqual(['sec-1']);
    expect(params[2]).toBeInstanceOf(Date);
  });

  it('多个标的一并传入 securityIds 数组（一次查全，无 N+1）', async () => {
    const ctx = setup(
      [
        trade({ id: 'tr-1', securityId: 'sec-1' }),
        trade({ id: 'tr-2', securityId: 'sec-2' }),
      ],
      [],
    );

    await ctx.service.deriveBatch(PORTFOLIO_ID, [d('2026-06-30')]);

    const { sql, params } = ctx.priceQueryArgs();
    expect(sql).toContain('ANY($2::text[])');
    expect(params[1]).toEqual(['sec-1', 'sec-2']);
  });

  it('价格行按 text security_id 匹配成功 → 估值 EXACT，市值 = 数量 × 现价', async () => {
    const ctx = setup(
      [trade()], // 100 股 @10，手续费 5 → costTotal=1005
      [priceRow()], // 现价 12.5，asOf 2026-06-15
    );

    const result = await ctx.service.deriveBatch(PORTFOLIO_ID, [d('2026-06-30')]);

    const views = result.get('2026-06-30')!;
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      securityId: 'sec-1',
      quantity: 100,
      avgCost: 10.05, // (100*10 + 5) / 100
      costTotal: 1005,
      marketPrice: 12.5,
      priceAsOf: '2026-06-15',
      marketValue: 1250,
      flag: 'EXACT',
    });
  });

  it('无价格记录 → 回退成本估值（COST_BASED，priceAsOf=null）', async () => {
    const ctx = setup([trade()], []);

    const result = await ctx.service.deriveBatch(PORTFOLIO_ID, [d('2026-06-30')]);

    const views = result.get('2026-06-30')!;
    expect(views[0]).toMatchObject({
      marketPrice: 10.05,
      priceAsOf: null,
      flag: 'COST_BASED',
    });
  });

  it('卖出量超持仓 → BadRequestException（400）', async () => {
    const ctx = setup(
      [trade({ side: SecuritySide.SELL_SEC, quantity: { toString: () => '200' } })],
      [],
    );

    await expect(
      ctx.service.deriveBatch(PORTFOLIO_ID, [d('2026-06-30')]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('空日期数组 / 无交易 → 空结果，不发 raw query', async () => {
    const emptyDates = setup([], []);
    await emptyDates.service.deriveBatch(PORTFOLIO_ID, []);
    expect(emptyDates.prisma.$queryRawUnsafe).not.toHaveBeenCalled();

    const noTrades = setup([], []);
    await noTrades.service.deriveBatch(PORTFOLIO_ID, [d('2026-06-30')]);
    expect(noTrades.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
