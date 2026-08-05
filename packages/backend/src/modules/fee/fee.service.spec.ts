/**
 * FeeService — 费用记录 CRUD 与数据隔离验收（HOLD-B-P0-10 / 阶段 C · Q-1 A）
 *
 * 验证点：
 * - **user_id 数据隔离（核心）**：所有 create/findAll/remove 都必须先按
 *   `{ id: portfolioId, userId }` 查组合；组合不属于当前用户 → 404，
 *   且**绝不允许**继续落到 feeRecord 的任何读写
 * - 二级隔离：securityId 必须属于同一组合，跨组合挂载 → 404
 * - 金额口径：NUMERIC(18,2) 字符串出入；≤ 0 / 非法 → 400
 * - transactionId 可选，缺省落 null
 * - C-09/D-03 隔离：服务不得触碰 cashFlow / 计算引擎
 *
 * 说明：prisma 全量 mock，不触库。
 */

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, FeeType } from '@prisma/client';
import { FeeService } from './fee.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CreateFeeRecordDto } from './dto/create-fee-record.dto';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const PORTFOLIO_ID = 'pf-1';
const SECURITY_ID = '11111111-1111-4111-8111-111111111111';
const TRADE_ID = '22222222-2222-4222-8222-222222222222';

/** 构造 prisma mock（默认：组合归属校验通过、标的归属校验通过） */
function createPrismaMock() {
  return {
    portfolio: { findFirst: jest.fn().mockResolvedValue({ id: PORTFOLIO_ID }) },
    security: { findFirst: jest.fn().mockResolvedValue({ id: SECURITY_ID }) },
    feeRecord: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: 'fee-1' }),
    },
    cashFlow: { create: jest.fn(), findMany: jest.fn() },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

/** 构造一条 prisma 层费用记录 */
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fee-1',
    portfolioId: PORTFOLIO_ID,
    securityId: SECURITY_ID,
    date: new Date('2025-08-01T00:00:00.000Z'),
    amount: new Prisma.Decimal('5.00'),
    type: FeeType.COMMISSION,
    transactionId: TRADE_ID,
    note: '买入佣金',
    createdAt: new Date('2025-08-01T09:15:00.000Z'),
    security: { name: '贵州茅台', code: '600519' },
    ...overrides,
  };
}

const DTO: CreateFeeRecordDto = {
  securityId: SECURITY_ID,
  date: '2025-08-01',
  amount: '5.00',
  type: FeeType.COMMISSION,
  transactionId: TRADE_ID,
  note: '买入佣金',
};

describe('FeeService', () => {
  let prisma: PrismaMock;
  let service: FeeService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new FeeService(prisma as unknown as PrismaService);
  });

  // =========================================================================
  // user_id 数据隔离
  // =========================================================================
  describe('user_id 数据隔离', () => {
    it('findAll：始终以 { id: portfolioId, userId } 校验组合归属', async () => {
      await service.findAll(PORTFOLIO_ID, USER_ID);

      expect(prisma.portfolio.findFirst).toHaveBeenCalledWith({
        where: { id: PORTFOLIO_ID, userId: USER_ID },
        select: { id: true },
      });
    });

    it('findAll：组合不属于当前用户 → 404，且不查费用表', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.findAll(PORTFOLIO_ID, OTHER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.feeRecord.findMany).not.toHaveBeenCalled();
    });

    it('create：组合不属于当前用户 → 404，且不写入费用表', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.create(PORTFOLIO_ID, OTHER_USER_ID, DTO),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.feeRecord.create).not.toHaveBeenCalled();
      expect(prisma.security.findFirst).not.toHaveBeenCalled();
    });

    it('remove：组合不属于当前用户 → 404，且不删除任何记录', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(PORTFOLIO_ID, 'fee-1', OTHER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.feeRecord.findFirst).not.toHaveBeenCalled();
      expect(prisma.feeRecord.delete).not.toHaveBeenCalled();
    });

    it('remove：记录 id 存在但不在本组合下 → 404，不删除', async () => {
      prisma.feeRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(PORTFOLIO_ID, 'fee-other', USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.feeRecord.findFirst).toHaveBeenCalledWith({
        where: { id: 'fee-other', portfolioId: PORTFOLIO_ID },
        select: { id: true },
      });
      expect(prisma.feeRecord.delete).not.toHaveBeenCalled();
    });

    it('create：标的不属于该组合 → 404（防跨组合挂载），不写入', async () => {
      prisma.security.findFirst.mockResolvedValue(null);

      await expect(
        service.create(PORTFOLIO_ID, USER_ID, DTO),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.feeRecord.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // create
  // =========================================================================
  describe('create', () => {
    it('落库字段正确，含 transactionId，金额以 Decimal 写入', async () => {
      prisma.feeRecord.create.mockResolvedValue(makeRecord());

      const result = await service.create(PORTFOLIO_ID, USER_ID, DTO);

      const args = prisma.feeRecord.create.mock.calls[0][0];
      expect(args.data.portfolioId).toBe(PORTFOLIO_ID);
      expect(args.data.securityId).toBe(SECURITY_ID);
      expect(args.data.type).toBe(FeeType.COMMISSION);
      expect(args.data.transactionId).toBe(TRADE_ID);
      expect(args.data.amount.toString()).toBe('5');
      expect(args.data.date.toISOString().split('T')[0]).toBe('2025-08-01');

      expect(result.amount).toBe('5');
      expect(result.date).toBe('2025-08-01');
      expect(result.transactionId).toBe(TRADE_ID);
      expect(result.securityCode).toBe('600519');
    });

    it('type 缺省落 OTHER，transactionId/note 缺省落 null', async () => {
      prisma.feeRecord.create.mockResolvedValue(
        makeRecord({ type: FeeType.OTHER, transactionId: null, note: null }),
      );

      const result = await service.create(PORTFOLIO_ID, USER_ID, {
        securityId: SECURITY_ID,
        date: '2025-08-01',
        amount: '1.50',
      });

      const args = prisma.feeRecord.create.mock.calls[0][0];
      expect(args.data.type).toBe(FeeType.OTHER);
      expect(args.data.transactionId).toBeNull();
      expect(args.data.note).toBeNull();
      expect(result.transactionId).toBeNull();
    });

    it.each(['0', '0.00', '-5.00'])(
      '金额 %s（≤ 0）→ 400，且不写入',
      async (amount) => {
        await expect(
          service.create(PORTFOLIO_ID, USER_ID, { ...DTO, amount }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.feeRecord.create).not.toHaveBeenCalled();
      },
    );

    it('金额非数字 → 400，且不写入', async () => {
      await expect(
        service.create(PORTFOLIO_ID, USER_ID, { ...DTO, amount: 'x1' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.feeRecord.create).not.toHaveBeenCalled();
    });

    it('C-09/D-03：写入费用不得触碰 cashFlow 表', async () => {
      prisma.feeRecord.create.mockResolvedValue(makeRecord());

      await service.create(PORTFOLIO_ID, USER_ID, DTO);

      expect(prisma.cashFlow.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // findAll
  // =========================================================================
  describe('findAll', () => {
    it('默认按 date desc 排序，where 仅含 portfolioId', async () => {
      await service.findAll(PORTFOLIO_ID, USER_ID);

      const args = prisma.feeRecord.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ portfolioId: PORTFOLIO_ID });
      expect(args.orderBy[0]).toEqual({ date: 'desc' });
    });

    it('传 securityId 时进入 where 过滤', async () => {
      await service.findAll(PORTFOLIO_ID, USER_ID, SECURITY_ID);

      const args = prisma.feeRecord.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        portfolioId: PORTFOLIO_ID,
        securityId: SECURITY_ID,
      });
    });

    it('映射为响应结构：金额字符串 + 日期 YYYY-MM-DD + 标的名称/代码', async () => {
      prisma.feeRecord.findMany.mockResolvedValue([makeRecord()]);

      const list = await service.findAll(PORTFOLIO_ID, USER_ID);

      expect(list[0]).toEqual({
        id: 'fee-1',
        portfolioId: PORTFOLIO_ID,
        securityId: SECURITY_ID,
        securityName: '贵州茅台',
        securityCode: '600519',
        date: '2025-08-01',
        amount: '5',
        type: FeeType.COMMISSION,
        transactionId: TRADE_ID,
        note: '买入佣金',
        createdAt: '2025-08-01T09:15:00.000Z',
      });
    });

    it('空列表返回 []', async () => {
      prisma.feeRecord.findMany.mockResolvedValue([]);

      await expect(service.findAll(PORTFOLIO_ID, USER_ID)).resolves.toEqual([]);
    });
  });

  // =========================================================================
  // remove
  // =========================================================================
  describe('remove', () => {
    it('归属校验通过后按 id 删除并返回 null', async () => {
      prisma.feeRecord.findFirst.mockResolvedValue({ id: 'fee-1' });

      await expect(
        service.remove(PORTFOLIO_ID, 'fee-1', USER_ID),
      ).resolves.toBeNull();

      expect(prisma.feeRecord.delete).toHaveBeenCalledWith({
        where: { id: 'fee-1' },
      });
    });
  });
});
