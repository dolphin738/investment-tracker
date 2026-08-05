/**
 * HoldingController — `types` 标的类型多选筛选 验收测试（Q-3 乙 · 阶段 B）
 *
 * 验证点（对齐 docs/holdings-overview-alignment.md §9 / §9.1）：
 * - 三种传参形态等价：`types=STOCK` / `types=STOCK,FUND` / `types=STOCK&types=FUND`
 * - 空值语义：未传 / `types=` / `types=,,` → 不过滤（返回全部）
 * - 白名单校验：非白名单值抛 400，且错误信息必须列出可选值
 * - **汇总口径唯一在后端（C-01）**：aggregate 对过滤后的子集求和，
 *   随筛选变化；子集 totalCost=0 时 totalProfitRate 必须为 0 而非 NaN
 * - 与 securityId / date / includeClosed 叠加正确
 * - 数据隔离：组合不属于当前用户 → 404
 *
 * 说明：prisma 与 holdingDerivationService 全部 mock，不触库。
 */

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SecurityType as PrismaSecurityType } from '@prisma/client';
import { SecurityType } from '@investment-tracker/shared';
import { HoldingController } from './holding.controller';
import type {
  HoldingDerivationService,
  HoldingView,
} from './holding-derivation.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const USER: AuthenticatedUser = {
  userId: 'user-1',
  email: 'u@example.com',
} as AuthenticatedUser;
const PORTFOLIO_ID = 'pf-1';

/** 构造一条持仓视图（只填筛选/汇总关心的字段） */
function makeHolding(overrides: Partial<HoldingView> = {}): HoldingView {
  return {
    securityId: 'sec-1',
    securityCode: '600519',
    securityName: '贵州茅台',
    securityType: 'STOCK',
    quantity: 100,
    avgCost: 10,
    costTotal: 1000,
    marketPrice: 12,
    priceAsOf: '2026-06-15',
    marketValue: 1200,
    pnl: 200,
    pnlRate: 0.2,
    flag: 'EXACT',
    ...overrides,
  };
}

/**
 * 固定夹具：3 类标的，便于逐类核对子集聚合
 * - STOCK：成本 1000，市值 1200，盈亏 +200
 * - FUND ：成本 2000，市值 1800，盈亏 -200
 * - BOND ：成本 500， 市值 500， 盈亏 0
 */
const STOCK = makeHolding({
  securityId: 'sec-stock',
  securityType: 'STOCK',
  costTotal: 1000,
  marketValue: 1200,
  pnl: 200,
});
const FUND = makeHolding({
  securityId: 'sec-fund',
  securityType: 'FUND',
  costTotal: 2000,
  marketValue: 1800,
  pnl: -200,
});
const BOND = makeHolding({
  securityId: 'sec-bond',
  securityType: 'BOND',
  costTotal: 500,
  marketValue: 500,
  pnl: 0,
});
const ALL = [STOCK, FUND, BOND];

function createController(items: HoldingView[] = ALL): {
  controller: HoldingController;
  derive: jest.Mock;
  findFirst: jest.Mock;
} {
  const derive = jest.fn(async () => items);
  const findFirst = jest.fn(async () => ({ id: PORTFOLIO_ID }));
  const prisma = { portfolio: { findFirst } };
  const derivation = { derive } as unknown as HoldingDerivationService;
  const controller = new HoldingController(
    derivation,
    prisma as unknown as PrismaService,
  );
  return { controller, derive, findFirst };
}

/** 便捷调用：只关心 types 参数时使用 */
function call(
  controller: HoldingController,
  types?: string | string[],
  extra: { date?: string; securityId?: string; includeClosed?: string } = {},
) {
  return controller.getHoldings(
    USER,
    PORTFOLIO_ID,
    extra.date,
    extra.securityId,
    extra.includeClosed,
    types,
  );
}

// ============================================================
// 1. 三种传参形态等价
// ============================================================

describe('HoldingController.getHoldings — types 传参形态（Q-3 乙）', () => {
  it('types=STOCK：只返回股票，且 items 就是该子集', async () => {
    const { controller } = createController();

    const res = await call(controller, 'STOCK');

    expect(res.items).toEqual([STOCK]);
    expect(res.items.every((h) => h.securityType === 'STOCK')).toBe(true);
  });

  it('types=STOCK,FUND（逗号分隔）返回股票+基金', async () => {
    const { controller } = createController();

    const res = await call(controller, 'STOCK,FUND');

    expect(res.items.map((h) => h.securityId)).toEqual([
      'sec-stock',
      'sec-fund',
    ]);
  });

  it('types=STOCK&types=FUND（重复参数 → string[]）结果与逗号分隔逐字段一致', async () => {
    const { controller: c1 } = createController();
    const { controller: c2 } = createController();

    const byComma = await call(c1, 'STOCK,FUND');
    const byRepeat = await call(c2, ['STOCK', 'FUND']);

    // 三形态一致性的核心断言：整个响应（items + aggregate）深度相等
    expect(byRepeat).toEqual(byComma);
  });

  it('单值的两种形态 types=STOCK 与 types=["STOCK"] 等价', async () => {
    const { controller: c1 } = createController();
    const { controller: c2 } = createController();

    expect(await call(c2, ['STOCK'])).toEqual(await call(c1, 'STOCK'));
  });

  it('带空格 types=" STOCK , FUND " 自动 trim 后正常过滤', async () => {
    const { controller } = createController();

    const res = await call(controller, ' STOCK , FUND ');

    expect(res.items.map((h) => h.securityType)).toEqual(['STOCK', 'FUND']);
  });

  it('重复值 types=STOCK,STOCK 去重，不导致条目重复', async () => {
    const { controller } = createController();

    const res = await call(controller, 'STOCK,STOCK');

    expect(res.items).toHaveLength(1);
    expect(res.aggregate.securityCount).toBe(1);
  });

  it('顺序不影响结果集合（types=FUND,STOCK 与 STOCK,FUND 命中同一批标的）', async () => {
    const { controller: c1 } = createController();
    const { controller: c2 } = createController();

    const a = await call(c1, 'FUND,STOCK');
    const b = await call(c2, 'STOCK,FUND');

    // items 顺序跟随 derive 原始顺序（不随 types 顺序变），故可直接比对
    expect(a).toEqual(b);
  });

  it('五个白名单值均可被单独接受（STOCK/FUND/BOND/CASH/OTHER）', async () => {
    for (const t of Object.values(SecurityType)) {
      const { controller } = createController();
      await expect(call(controller, t)).resolves.toBeDefined();
    }
  });
});

// ============================================================
// 2. 空值语义 = 不过滤
// ============================================================

describe('HoldingController.getHoldings — types 空值语义', () => {
  it('未传 types → 返回全部类型', async () => {
    const { controller } = createController();

    const res = await call(controller, undefined);

    expect(res.items).toHaveLength(3);
    expect(res.aggregate.securityCount).toBe(3);
  });

  it('types=（空串）→ 不过滤，与未传等价', async () => {
    const { controller: c1 } = createController();
    const { controller: c2 } = createController();

    expect(await call(c1, '')).toEqual(await call(c2, undefined));
  });

  it('types=,,（全是空项）→ 不过滤，不得抛 400', async () => {
    const { controller } = createController();

    const res = await call(controller, ',,');

    expect(res.items).toHaveLength(3);
  });

  it('types=[]（空数组）→ 不过滤', async () => {
    const { controller } = createController();

    const res = await call(controller, []);

    expect(res.items).toHaveLength(3);
  });
});

// ============================================================
// 3. 白名单校验（400）
// ============================================================

describe('HoldingController.getHoldings — types 白名单校验', () => {
  it('types=INVALID → 抛 BadRequestException（400）', async () => {
    const { controller } = createController();

    await expect(call(controller, 'INVALID')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400 错误信息必须列出全部可选值，便于前端排错', async () => {
    const { controller } = createController();

    await expect(call(controller, 'INVALID')).rejects.toThrow(/INVALID/);
    await expect(call(controller, 'INVALID')).rejects.toThrow(
      /STOCK.*FUND.*BOND.*CASH.*OTHER/,
    );
  });

  it('混入一个非法值即整体 400（types=STOCK,NOPE）', async () => {
    const { controller } = createController();

    await expect(call(controller, 'STOCK,NOPE')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('大小写敏感：types=stock 视为非法（避免与 Prisma 枚举大小写错配）', async () => {
    const { controller } = createController();

    await expect(call(controller, 'stock')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('非法值必须在推导之前快速失败（不做无谓的流水回放）', async () => {
    const { controller, derive } = createController();

    await expect(call(controller, 'INVALID')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(derive).not.toHaveBeenCalled();
  });

  it('归属权校验优先于类型校验：非本人组合即便 types 非法也回 404', async () => {
    const { controller, findFirst } = createController();
    findFirst.mockResolvedValueOnce(null);

    await expect(call(controller, 'INVALID')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ============================================================
// 4. 汇总随筛选变化（C-01 口径唯一在后端）
// ============================================================

describe('HoldingController.getHoldings — aggregate 子集聚合（C-01）', () => {
  it('不筛选：aggregate = 全集求和', async () => {
    const { controller } = createController();

    const { aggregate } = await call(controller, undefined);

    expect(aggregate.totalMarketValue).toBe(1200 + 1800 + 500);
    expect(aggregate.totalCost).toBe(1000 + 2000 + 500);
    expect(aggregate.totalProfit).toBe(200 - 200 + 0);
    expect(aggregate.securityCount).toBe(3);
  });

  it('types=STOCK：aggregate 收缩为股票子集求和（而非仍报全集）', async () => {
    const { controller } = createController();

    const { aggregate } = await call(controller, 'STOCK');

    expect(aggregate.totalMarketValue).toBe(1200);
    expect(aggregate.totalCost).toBe(1000);
    expect(aggregate.totalProfit).toBe(200);
    expect(aggregate.totalProfitRate).toBeCloseTo(0.2, 10);
    expect(aggregate.securityCount).toBe(1);
  });

  it('types=FUND：负盈亏子集，profitRate 为负', async () => {
    const { controller } = createController();

    const { aggregate } = await call(controller, 'FUND');

    expect(aggregate.totalProfit).toBe(-200);
    expect(aggregate.totalProfitRate).toBeCloseTo(-0.1, 10);
  });

  it('types=STOCK,FUND：两类之和，且与逐条累加一致', async () => {
    const { controller } = createController();

    const { items, aggregate } = await call(controller, 'STOCK,FUND');

    expect(aggregate.totalMarketValue).toBe(
      items.reduce((s, h) => s + h.marketValue, 0),
    );
    expect(aggregate.totalCost).toBe(items.reduce((s, h) => s + h.costTotal, 0));
    expect(aggregate.totalProfit).toBe(items.reduce((s, h) => s + h.pnl, 0));
    expect(aggregate.securityCount).toBe(items.length);
  });

  it('筛出空集：全部归零，securityCount=0，且 totalProfitRate 不是 NaN', async () => {
    const { controller } = createController();

    const { items, aggregate } = await call(controller, 'CASH');

    expect(items).toHaveLength(0);
    expect(aggregate.totalMarketValue).toBe(0);
    expect(aggregate.totalCost).toBe(0);
    expect(aggregate.totalProfit).toBe(0);
    expect(aggregate.securityCount).toBe(0);
    expect(Number.isNaN(aggregate.totalProfitRate)).toBe(false);
    expect(aggregate.totalProfitRate).toBe(0);
  });

  it('【关键】子集 totalCost=0 但有市值时，totalProfitRate=0 而非 Infinity/NaN', async () => {
    // 场景：现金类持仓成本为 0（或全部清仓后仍 includeClosed）
    const zeroCost = makeHolding({
      securityId: 'sec-cash',
      securityType: 'CASH',
      costTotal: 0,
      marketValue: 300,
      pnl: 300,
    });
    const { controller } = createController([STOCK, zeroCost]);

    const { aggregate } = await call(controller, 'CASH');

    expect(aggregate.totalCost).toBe(0);
    expect(aggregate.totalProfit).toBe(300);
    expect(aggregate.totalProfitRate).toBe(0);
    expect(Number.isFinite(aggregate.totalProfitRate)).toBe(true);
  });

  it('正负成本相抵导致子集 totalCost=0 时同样回 0（不触发除零）', async () => {
    const negative = makeHolding({
      securityId: 'sec-o1',
      securityType: 'OTHER',
      costTotal: -500,
      marketValue: 100,
      pnl: 600,
    });
    const positive = makeHolding({
      securityId: 'sec-o2',
      securityType: 'OTHER',
      costTotal: 500,
      marketValue: 400,
      pnl: -100,
    });
    const { controller } = createController([negative, positive]);

    const { aggregate } = await call(controller, 'OTHER');

    expect(aggregate.totalCost).toBe(0);
    expect(aggregate.totalProfitRate).toBe(0);
  });
});

// ============================================================
// 5. 与其他查询参数叠加
// ============================================================

describe('HoldingController.getHoldings — types 与其他参数叠加', () => {
  it('types + securityId 取交集（命中）', async () => {
    const { controller } = createController();

    const res = await call(controller, 'STOCK,FUND', {
      securityId: 'sec-fund',
    });

    expect(res.items).toEqual([FUND]);
    expect(res.aggregate.securityCount).toBe(1);
    expect(res.aggregate.totalMarketValue).toBe(1800);
  });

  it('types + securityId 冲突（该标的不属于所选类型）→ 空集且汇总归零', async () => {
    const { controller } = createController();

    const res = await call(controller, 'FUND', { securityId: 'sec-stock' });

    expect(res.items).toHaveLength(0);
    expect(res.aggregate.totalMarketValue).toBe(0);
    expect(res.aggregate.totalProfitRate).toBe(0);
  });

  it('types + includeClosed=true：includeClosed 透传给 derive，类型过滤照常', async () => {
    const closedFund = makeHolding({
      securityId: 'sec-fund-closed',
      securityType: 'FUND',
      quantity: 0,
      costTotal: 0,
      marketValue: 0,
      pnl: 0,
    });
    const { controller, derive } = createController([...ALL, closedFund]);

    const res = await call(controller, 'FUND', { includeClosed: 'true' });

    expect(derive).toHaveBeenCalledWith(PORTFOLIO_ID, expect.any(Date), true);
    expect(res.items.map((h) => h.securityId)).toEqual([
      'sec-fund',
      'sec-fund-closed',
    ]);
  });

  it('types + includeClosed 缺省：derive 收到 false', async () => {
    const { controller, derive } = createController();

    await call(controller, 'STOCK');

    expect(derive).toHaveBeenCalledWith(PORTFOLIO_ID, expect.any(Date), false);
  });

  it('types + date：目标日期按参数解析后透传，类型过滤不受影响', async () => {
    const { controller, derive } = createController();

    const res = await call(controller, 'BOND', { date: '2026-03-31' });

    const [, passedDate] = derive.mock.calls[0] as [string, Date, boolean];
    expect(passedDate.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(res.items).toEqual([BOND]);
  });

  it('types + date + securityId + includeClosed 四参数同时生效', async () => {
    const { controller, derive } = createController();

    const res = await call(controller, 'STOCK,FUND,BOND', {
      date: '2026-03-31',
      securityId: 'sec-bond',
      includeClosed: 'true',
    });

    expect(derive).toHaveBeenCalledWith(PORTFOLIO_ID, expect.any(Date), true);
    expect(res.items).toEqual([BOND]);
    expect(res.aggregate.securityCount).toBe(1);
  });
});

// ============================================================
// 6. 白名单来源一致性（用户硬要求：SecurityType 单一定义）
// ============================================================

describe('SecurityType 白名单来源（shared 单一定义）', () => {
  it('shared 导出的 SecurityType 恰好是 5 个约定值', () => {
    expect(Object.values(SecurityType).sort()).toEqual(
      ['BOND', 'CASH', 'FUND', 'OTHER', 'STOCK'].sort(),
    );
  });

  it('【防漂移】shared 取值与 Prisma schema 枚举完全一致（契约 ↔ DB 不脱节）', () => {
    expect(Object.values(SecurityType).slice().sort()).toEqual(
      Object.values(PrismaSecurityType).slice().sort(),
    );
  });

  it('controller 接受的类型集合 = shared 的取值集合（无遗漏、无多余）', async () => {
    // 全部 shared 值都应被接受
    for (const t of Object.values(SecurityType)) {
      const { controller } = createController();
      await expect(call(controller, t)).resolves.toBeDefined();
    }
    // 任何非 shared 值都应被拒
    for (const bad of ['EQUITY', 'ETF', 'stock', 'Stock', 'NONE']) {
      const { controller } = createController();
      await expect(call(controller, bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});
