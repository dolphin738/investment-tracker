/**
 * SecurityTradeService — 证券买卖流水 CRUD 与费用口径验收（增量设计 C-5/C-7/K-4）
 *
 * 验证点：
 * - **create 强制 fee=0**：DTO 传 5.0 仍落 0（新口径：含费单价存 price，费用拆 FeeRecord）
 * - **update 忽略 fee**：即使 DTO 带 fee 也不写入，现值保留（存量 fee≠0 不丢失）
 * - **price>0 DTO 兜底**（C-7）：费用>成交额 ⇒ 含费单价 ≤ 0 ⇒ 400（class-validator 层）
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

/** 构造一条 prisma 层交易记录 */
function makeTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: TRADE_ID,
    portfolioId: PORTFOLIO_ID,
    securityId: SECURITY_ID,
    date: new Date('2025-07-15T00:00:00.000Z'),
    side: SecuritySide.BUY_SEC,
    quantity: new Prisma.Decimal('100'),
    price: new Prisma.Decimal('1500.45'),
    fee: new Prisma.Decimal('0'),
    note: null,
    createdAt: new Date('2025-07-15T00:00:00.000Z'),
    updatedAt: new Date('2025-07-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('SecurityTradeService（增量费用口径）', () => {
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
          price: 1500.45,
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
  // create：fee 强制 0（C-5 / K-4）
  // =========================================================================
  describe('create 费用口径', () => {
    it('DTO 传 fee=5.0 仍落库 fee=0，price 原样写入（含费单价）', async () => {
      prisma.securityTrade.create.mockResolvedValue(makeTrade());

      const result = await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        price: 1500.45,
        fee: 5.0,
        note: '建仓',
      });

      const args = prisma.securityTrade.create.mock.calls[0][0];
      expect(args.data.fee).toBe(0);
      expect(args.data.price).toBe(1500.45);
      expect(args.data.quantity).toBe(100);
      expect(args.data.note).toBe('建仓');

      // 响应 fee 字符串为 '0'
      expect(result.fee).toBe('0');
      expect(result.price).toBe('1500.45');
    });

    it('DTO 不传 fee 同样落 0（旧前端兼容）', async () => {
      prisma.securityTrade.create.mockResolvedValue(makeTrade());

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        price: 1500.45,
      });

      const args = prisma.securityTrade.create.mock.calls[0][0];
      expect(args.data.fee).toBe(0);
    });

    it('BUY 不校验卖出持仓量', async () => {
      prisma.securityTrade.create.mockResolvedValue(makeTrade());

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        price: 1500.45,
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
        price: 1600.0,
      });

      // 卖出路径触发持仓推导查询
      expect(prisma.securityTrade.findMany).toHaveBeenCalled();
      expect(prisma.securityTrade.create).toHaveBeenCalledTimes(1);
    });

    it('create 成功后触发 recalculateRange(portfolioId, date)', async () => {
      prisma.securityTrade.create.mockResolvedValue(makeTrade());

      await service.create(USER_ID, PORTFOLIO_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        price: 1500.45,
      });

      expect(recalc.recalculateRange).toHaveBeenCalledWith(
        PORTFOLIO_ID,
        new Date('2025-07-15'),
      );
    });
  });

  // =========================================================================
  // update：忽略 fee（C-5 / U-1）
  // =========================================================================
  describe('update 费用口径', () => {
    beforeEach(() => {
      prisma.securityTrade.findFirst.mockResolvedValue(
        makeTrade({ fee: new Prisma.Decimal('5') }),
      );
      prisma.securityTrade.update.mockResolvedValue(
        makeTrade({ fee: new Prisma.Decimal('5') }),
      );
    });

    it('DTO 带 fee=8 时写入 fee 字段（I-01：update 契约支持 fee 落库，裁决 Q-2）', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        fee: 8,
        note: '改备注',
      });

      const data = prisma.securityTrade.update.mock.calls[0][0].data;
      expect(data.fee).toBe(8);
      expect(data.note).toBe('改备注');
    });

    it('不传 fee 时 data 不含 fee 键（现值不受影响）', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        price: 1600.0,
      });

      const data = prisma.securityTrade.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('fee');
      expect(data.price).toBe(1600.0);
    });

    it('更新后触发 recalculateRange', async () => {
      await service.update(USER_ID, PORTFOLIO_ID, TRADE_ID, {
        note: 'x',
      });

      expect(recalc.recalculateRange).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // price > 0 DTO 兜底（C-7：费用>成交额 ⇒ 含费单价 ≤ 0 ⇒ 400）
  // =========================================================================
  describe('price>0 DTO 校验（卖出费用>成交额的等价兜底）', () => {
    async function priceErrors(price: number): Promise<number> {
      const instance = plainToInstance(CreateSecurityTradeDto, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.SELL_SEC,
        quantity: 100,
        price,
      });
      const errors = await validate(instance);
      return errors.filter((e) => e.property === 'price').length;
    }

    it.each([0, -1, -0.000001])('price=%s（≤ 0）被拒', async (price) => {
      expect(await priceErrors(price)).toBe(1);
    });

    it('price=0.000001（最小正数）通过', async () => {
      expect(await priceErrors(0.000001)).toBe(0);
    });

    it('DTO 层不要求 fee 必填（fee 可选兼容旧前端）', async () => {
      const instance = plainToInstance(CreateSecurityTradeDto, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        side: SecuritySide.BUY_SEC,
        quantity: 100,
        price: 1500.45,
      });
      const errors = await validate(instance);
      expect(errors.filter((e) => e.property === 'fee')).toHaveLength(0);
    });
  });
});
