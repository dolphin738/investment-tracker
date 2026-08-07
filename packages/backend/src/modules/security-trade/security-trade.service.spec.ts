/**
 * SecurityTradeService — 证券买卖流水 CRUD 与费用物理并表验收（INC-03 / INC-04）
 *
 * 验证点：
 * - **create 落库 costPrice + 分项费用**：commission/stampTax/other 缺省 0；
 *   feeTotal = 三项之和（冗余展示列，决策 B/C-09 不回冲成本）
 * - **update 分项费用可写**：传入 commission/stampTax/other 任一即重算 feeTotal；
 *   未传字段沿用存量值
 * - **costPrice>0 DTO 兜底**（C-7）：含费单价 ≤ 0 ⇒ 400（class-validator 层）
 * - 卖出硬校验：validateSellQuantity 在 create/update 的 SELL 路径被调用
 * - 写入后触发 recalculateRange（T2）
 * - 数据隔离：组合不属于当前用户 → 404
 *
 * 说明：prisma 与 recalculation 全量 mock，不触库。
 */

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SecuritySide } from '@investment-tracker/shared';
import { SecurityTradeService } from './security-trade.service';
import { CreateSecurityTradeDto } from './security-trade.dto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RecalculationService } from '../recalculation/recalculation.service';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const PORTFOLIO_ID = 'pf-1';
const SECURITY_ID = '11111111-1111-4111-8111-111111111111';
const TRADE_ID = '33333333-3333-4333-8333-333333333333';

/** 构造 prisma mock（默认：组合归属通过、无历史交易） */
function createPrismaMock() {
  return {
    portfolio: { findFirst: jest.fn().mockResolvedValue({ id: PORTFOLIO_ID }) },
    securityTrade: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: TRADE_ID }),
    },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

/** 构造一条 prisma 层交易记录（INC-03/INC-04：costPrice + 分项费用 + feeTotal） */
function makeTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: TRADE_ID,
    portfolioId: PORTFOLIO_ID,
    securityId: SECURITY_ID,
    date: new Date('2025-07-15T00:00:00.000Z'),
    side: SecuritySide.BUY_SEC,
    quantity: new Prisma.Decimal('100'),
    costPrice: new Prisma.Decimal('1500.45'),
    commission: new Prisma.Decimal('0'),
    stampTax: new Prisma.Decimal('0'),
    other: new Prisma.Decimal('0'),
    feeTotal: new Prisma.Decimal('0'),
    note: null,
    createdAt: new Date('2025-07-15T00:00:00.000Z'),
    updatedAt: new Date('2025-07-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('SecurityTradeService（增量费用物理并表）', () => {
  let prisma: PrismaMock;
  let recalc: { recalculateRange: jest.Mock };
  let service: SecurityTradeService;

  beforeEach(() => {
    prisma = createPrismaMock();
    recalc = { recalculateRange: jest.fn().mockResolvedValue(undefined) };
    service = new SecurityTradeService(
      prisma as unknown as PrismaService,
      recalc as unknown as RecalculationService,
    );
  });

  // =========================================================================
  // 数据隔离
  // =========================================================================
  describe('user_id 数据隔离', () => {
    it('create：组合不属于当前用户 → 404，不写入', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.create(OTHER_USER_ID, PORTFOLIO_ID, {
          securityId: SECURITY_ID,
          date: '2025-07-15',
          side: SecuritySide.BUY_SEC,
          quantity: 100,
          costPrice: 1500.45,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.securityTrade.create).not.toHaveBeenCalled();
    });

    it('update：组合不属于当前用户 → 404，不更新', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.update(OTHER_USER_ID, PORTFOLIO_ID, TRADE_ID, {
          note: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.securityTrade.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // create：costPrice + 分项费用 + feeTotal = Σ
  // =========================================================================
  describe('create 费用物理并表', () => {
    it('DTO 传 commission/stampTax/other → feeTotal = 三项之和，costPrice 原样写入', async () => {
      prisma.securityTrade.create.mockImplementation((args) =>
        makeTrade({ ...(args as { data: Record<string, unknown> }).data }),
      );

      const result = await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        costPrice: 1500.45,
        commission: 3,
        stampTax: 1.5,
        other: 0.5,
        note: '建仓',
      });

      const args = prisma.securityTrade.create.mock.calls[0][0];
      // costPrice/quantity 为原始数值；commission/stampTax/other/feeTotal 以 Decimal 入库
      expect(args.data.costPrice).toBe(1500.45);
      expect(args.data.commission.toString()).toBe('3');
      expect(args.data.stampTax.toString()).toBe('1.5');
      expect(args.data.other.toString()).toBe('0.5');
      // feeTotal = 3 + 1.5 + 0.5 = 5
      expect(args.data.feeTotal.toString()).toBe('5');
      expect(args.data.quantity).toBe(100);
      expect(args.data.note).toBe('建仓');

      // 响应：feeTotal/costPrice/分项均以字符串回传
      expect(result.costPrice).toBe('1500.45');
      expect(result.commission).toBe('3');
      expect(result.stampTax).toBe('1.5');
      expect(result.other).toBe('0.5');
      expect(result.feeTotal).toBe('5');
    });

    it('create 响应字段集为改名后字段（costPrice/feeTotal/commission/stampTax/other），不含旧 price/fee 键（INC-03 列改名）', async () => {
      prisma.securityTrade.create.mockImplementation((args) =>
        makeTrade({ ...(args as { data: Record<string, unknown> }).data }),
      );

      const result = await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        costPrice: 1500.45,
        commission: 3,
        stampTax: 1.5,
        other: 0.5,
      });

      const keys = Object.keys(result);
      for (const k of [
        'costPrice',
        'feeTotal',
        'commission',
        'stampTax',
        'other',
      ]) {
        expect(keys).toContain(k);
        expect(typeof (result as unknown as Record<string, unknown>)[k]).toBe('string');
      }
      // 旧字段名不得残留（物理并表后无 price/fee）
      expect(keys).not.toContain('price');
      expect(keys).not.toContain('fee');
    });

    it('分项费用缺省为 0，feeTotal = 0', async () => {
      prisma.securityTrade.create.mockImplementation((args) =>
        makeTrade({ ...(args as { data: Record<string, unknown> }).data }),
      );

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        costPrice: 1500.45,
      });

      const args = prisma.securityTrade.create.mock.calls[0][0];
      expect(args.data.commission.toString()).toBe('0');
      expect(args.data.stampTax.toString()).toBe('0');
      expect(args.data.other.toString()).toBe('0');
      expect(args.data.feeTotal.toString()).toBe('0');
    });

    it('BUY 不校验卖出持仓量', async () => {
      prisma.securityTrade.create.mockImplementation((args) =>
        makeTrade({ ...(args as { data: Record<string, unknown> }).data }),
      );

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        costPrice: 1500.45,
      });

      // findMany 仅用于校验卖出；买入不应触发
      expect(prisma.securityTrade.findMany).not.toHaveBeenCalled();
    });

    it('SELL 卖出前校验持仓量（validateSellQuantity）', async () => {
      // 前置：日期前已有一笔买入 100 → 当前持仓 100，卖出 50 合法
      prisma.securityTrade.findMany.mockResolvedValue([
        { side: SecuritySide.BUY_SEC, quantity: new Prisma.Decimal('100') },
      ]);
      prisma.securityTrade.create.mockResolvedValue(
        makeTrade({ side: SecuritySide.SELL_SEC }),
      );

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.SELL_SEC,
        quantity: 50,
        costPrice: 1600.0,
      });

      // 卖出路径触发持仓推导查询
      expect(prisma.securityTrade.findMany).toHaveBeenCalled();
      expect(prisma.securityTrade.create).toHaveBeenCalledTimes(1);
    });

    it('create 成功后触发 recalculateRange(portfolioId, date)', async () => {
      prisma.securityTrade.create.mockImplementation((args) =>
        makeTrade({ ...(args as { data: Record<string, unknown> }).data }),
      );

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        costPrice: 1500.45,
      });

      expect(recalc.recalculateRange).toHaveBeenCalledWith(
        PORTFOLIO_ID,
        new Date('2025-07-15'),
      );
    });
  });

  // =========================================================================
  // update：分项费用可写，feeTotal 重算
  // =========================================================================
  describe('update 费用物理并表', () => {
    beforeEach(() => {
      prisma.securityTrade.findFirst.mockResolvedValue(
        makeTrade({
          commission: new Prisma.Decimal('1'),
          stampTax: new Prisma.Decimal('0'),
          other: new Prisma.Decimal('0'),
          feeTotal: new Prisma.Decimal('1'),
        }),
      );
      prisma.securityTrade.update.mockResolvedValue(
        makeTrade({
          commission: new Prisma.Decimal('1'),
          stampTax: new Prisma.Decimal('0'),
          other: new Prisma.Decimal('0'),
          feeTotal: new Prisma.Decimal('1'),
        }),
      );
    });

    it('DTO 传 stampTax=2 → feeTotal 重算为 commission+2+other = 3', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        stampTax: 2,
        note: '改备注',
      });

      const data = prisma.securityTrade.update.mock.calls[0][0].data;
      // 仅传 stampTax=2 → 三项整体重写入库，commission/other 沿用存量（Decimal）
      expect(data.stampTax.toString()).toBe('2');
      expect(data.commission.toString()).toBe('1'); // 沿用存量
      expect(data.other.toString()).toBe('0');
      expect(data.feeTotal.toString()).toBe('3'); // 1 + 2 + 0
      expect(data.note).toBe('改备注');
    });

    it('DTO 仅传 commission=4（其余沿用存量）→ feeTotal 重算为 4+0+0 = 4（守卫单字段丢失 bug）', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        commission: 4,
      });

      const data = prisma.securityTrade.update.mock.calls[0][0].data;
      // 仅传 commission=4 → 三项整体重写入库，stampTax/other 沿用存量（Decimal）
      expect(data.commission.toString()).toBe('4');
      expect(data.stampTax.toString()).toBe('0'); // 沿用存量
      expect(data.other.toString()).toBe('0'); // 沿用存量
      expect(data.feeTotal.toString()).toBe('4'); // 4 + 0 + 0
    });

    it('不传任何分项费用时 data 不含 feeTotal/commission 键（现值不受影响）', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        costPrice: 1600.0,
      });

      const data = prisma.securityTrade.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('feeTotal');
      expect(data).not.toHaveProperty('commission');
      expect(data).not.toHaveProperty('stampTax');
      expect(data).not.toHaveProperty('other');
      expect(data.costPrice).toBe(1600.0);
    });

    it('更新后触发 recalculateRange', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        note: 'x',
      });

      expect(recalc.recalculateRange).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // costPrice > 0 DTO 兜底（C-7）
  // =========================================================================
  describe('costPrice>0 DTO 校验', () => {
    async function costPriceErrors(costPrice: number): Promise<number> {
      const instance = plainToInstance(CreateSecurityTradeDto, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.SELL_SEC,
        quantity: 100,
        costPrice,
      });
      const errors = await validate(instance);
      return errors.filter((e) => e.property === 'costPrice').length;
    }

    it.each([0, -1, -0.000001])('costPrice=%s（≤ 0）被拒', async (costPrice) => {
      expect(await costPriceErrors(costPrice)).toBe(1);
    });

    it('costPrice=0.000001（最小正数）通过', async () => {
      expect(await costPriceErrors(0.000001)).toBe(0);
    });

    it('DTO 层不要求 commission/stampTax/other/feeTotal 必填（缺省 0）', async () => {
      const instance = plainToInstance(CreateSecurityTradeDto, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        costPrice: 1500.45,
      });
      const errors = await validate(instance);
      expect(
        errors.filter((e) =>
          ['commission', 'stampTax', 'other', 'feeTotal'].includes(e.property),
        ),
      ).toHaveLength(0);
    });
  });
});
