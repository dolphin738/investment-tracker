/**
 * OverviewService.buildFreshness — 数据新鲜度口径验收（PRD DASH-P1-03 / AL-015 · 决策 O-6）
 *
 * 验证点：
 * - staleDays 读 UserPreference（缺省 3）
 * - 行情维度口径 = MIN(MAX(SecurityPrice.asOf) per held security)（最落后那只）
 * - 现金维度口径 = MAX(CashBalance.asOf)
 * - 滞后天数 = asOf → 今天（todayInAppTz，UTC+8）自然日差
 * - isStale / reasons：任一维度超过阈值即 stale（持仓标的缺行情也算陈旧）
 * - 🔴 不使用快照 latestDate 作为陈旧判定
 *
 * prisma / holdingDerivationService 全部 mock；todayInAppTz 用可控 mock 固定为 2026-08-05。
 */

import 'reflect-metadata';
import { OverviewService } from './overview.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { HoldingDerivationService } from '../holding/holding-derivation.service';

// 固定"今天"为北京时间 2026-08-05，使滞后天数可确定
jest.mock('../../common/utils/app-date.util', () => ({
  todayInAppTz: jest.fn(() => new Date('2026-08-05T00:00:00.000Z')),
}));

const PORTFOLIO_ID = 'pf-1';
const USER_ID = 'user-1';
const TODAY = '2026-08-05';

/** 转 UTC 午夜 Date（与 DB @db.Date 一致） */
function d(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function createService(options: {
  staleDays?: number | null;
  priceGroupBy?: Array<{ securityId: string; _max: { asOf: Date | null } }>;
  cashMaxAsOf?: Date | null;
}) {
  const {
    staleDays = 3,
    priceGroupBy = [],
    cashMaxAsOf = null,
  } = options;

  const prisma = {
    userPreference: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          staleDays === null ? null : { staleDays },
        ),
    },
    securityPrice: {
      groupBy: jest.fn().mockResolvedValue(priceGroupBy),
    },
    cashBalance: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _max: { asOf: cashMaxAsOf } }),
    },
  };

  const derivation = {} as unknown as HoldingDerivationService;
  const service = new OverviewService(
    prisma as unknown as PrismaService,
    derivation,
  );

  return { service, prisma };
}

describe('OverviewService.buildFreshness — staleDays 来源', () => {
  it('UserPreference 缺失 → 默认 3', async () => {
    const { service } = createService({ staleDays: null });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, []);
    expect(f.staleDays).toBe(3);
  });

  it('UserPreference.staleDays = 7 → 取 7', async () => {
    const { service } = createService({ staleDays: 7 });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, []);
    expect(f.staleDays).toBe(7);
  });
});

describe('OverviewService.buildFreshness — 行情维度（最落后那只）', () => {
  it('MIN(MAX(asOf)) 取最落后日期，滞后天数正确', async () => {
    const { service } = createService({
      priceGroupBy: [
        { securityId: 's1', _max: { asOf: d('2026-08-03') } },
        { securityId: 's2', _max: { asOf: d('2026-08-01') } }, // 最落后
      ],
      cashMaxAsOf: d('2026-08-04'),
    });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, [
      's1',
      's2',
    ]);

    expect(f.latestPriceAsOf).toBe('2026-08-01');
    expect(f.latestPriceLagDays).toBe(4); // 08-01 → 08-05
    expect(f.latestCashAsOf).toBe('2026-08-04');
    expect(f.latestCashLagDays).toBe(1);
  });

  it('持仓标的中有一只完全无行情 → latestPriceAsOf=null，判定陈旧', async () => {
    const { service } = createService({
      // 只返回 s1（s2 无行情记录）
      priceGroupBy: [{ securityId: 's1', _max: { asOf: d('2026-08-03') } }],
      cashMaxAsOf: d('2026-08-05'),
    });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, [
      's1',
      's2',
    ]);

    expect(f.latestPriceAsOf).toBeNull();
    expect(f.latestPriceLagDays).toBeNull();
    // 现金当日（lag 0）不陈旧，但行情缺数据 → 整体 isStale
    expect(f.isStale).toBe(true);
    const priceReason = f.reasons.find(
      (r: { kind: string }) => r.kind === 'PRICE',
    );
    expect(priceReason).toBeDefined();
    expect(priceReason.asOf).toBeNull();
  });
});

describe('OverviewService.buildFreshness — 阈值与 reasons', () => {
  it('全部在阈值内 → isStale=false，reasons 为空', async () => {
    const { service } = createService({
      staleDays: 3,
      priceGroupBy: [{ securityId: 's1', _max: { asOf: d('2026-08-04') } }], // lag 1
      cashMaxAsOf: d('2026-08-03'), // lag 2
    });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, [
      's1',
    ]);

    expect(f.latestPriceLagDays).toBe(1);
    expect(f.latestCashLagDays).toBe(2);
    expect(f.isStale).toBe(false);
    expect(f.reasons).toEqual([]);
  });

  it('仅现金超阈值 → 仅有 CASH reason', async () => {
    const { service } = createService({
      staleDays: 3,
      priceGroupBy: [{ securityId: 's1', _max: { asOf: d('2026-08-04') } }], // lag 1
      cashMaxAsOf: d('2026-07-30'), // lag 6 > 3
    });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, [
      's1',
    ]);

    expect(f.isStale).toBe(true);
    expect(f.reasons).toHaveLength(1);
    expect(f.reasons[0].kind).toBe('CASH');
    expect(f.reasons[0].lagDays).toBe(6);
  });

  it('无持仓 → 行情维度为 null 且不因行情陈旧（仅现金判定）', async () => {
    const { service } = createService({
      cashMaxAsOf: d('2026-08-05'), // 当日
    });
    const f = await (service as any).buildFreshness(PORTFOLIO_ID, USER_ID, []);

    expect(f.latestPriceAsOf).toBeNull();
    expect(f.latestPriceLagDays).toBeNull();
    expect(f.isStale).toBe(false); // 无现金滞后
    expect(f.reasons).toEqual([]);
  });
});
