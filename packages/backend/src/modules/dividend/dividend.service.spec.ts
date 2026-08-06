/**
 * DividendService — 分红记录 CRUD 与数据隔离验收（HOLD-B-P0-10 / 阶段 C · Q-1 A + 增量 R-2/R-5）
 *
 * 验证点：
 * - **user_id 数据隔离（核心）**：所有 create/findAll/update/remove 都必须先按
 *   `{ id: portfolioId, userId }` 查组合；组合不属于当前用户 → 404，
 *   且**绝不允许**继续落到 dividendRecord 的任何读写
 * - 二级隔离：securityId 必须属于同一组合，跨组合挂载 → 404
 * - 金额口径：NUMERIC(18,2) 字符串出入；≤ 0 / 非法 → 400
 * - 所得税口径（增量）：parseTax ≥ 0；validateNetAmount amount − tax ≥ 0；
 *   响应统一带 tax / netAmount（toFixed(2) 字符串）
 * - 更新（增量）：PATCH 全可选；净额以更新后值校验；双闸 404
 * - 列表按 date desc 排序、securityId 过滤进 where、附带 securityName/Code
 * - C-08/D-02 隔离：服务不得触碰 cashFlow / 计算引擎
 *
 * 说明：prisma 全量 mock，不触库。
 */

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, DividendType } from '@prisma/client';
import { DividendService } from './dividend.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CreateDividendRecordDto } from './dto/create-dividend-record.dto';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const PORTFOLIO_ID = 'pf-1';
const SECURITY_ID = '11111111-1111-4111-8111-111111111111';

/** 构造 prisma mock（默认：组合归属校验通过、标的归属校验通过） */
function createPrismaMock() {
  return {
    portfolio: { findFirst: jest.fn().mockResolvedValue({ id: PORTFOLIO_ID }) },
    security: { findFirst: jest.fn().mockResolvedValue({ id: SECURITY_ID }) },
    dividendRecord: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: 'div-1' }),
    },
    cashFlow: { create: jest.fn(), findMany: jest.fn() },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

/** 构造一条 prisma 层分红记录（含 tax；未传则默认 0） */
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'div-1',
    portfolioId: PORTFOLIO_ID,
    securityId: SECURITY_ID,
    date: new Date('2025-07-15T00:00:00.000Z'),
    amount: new Prisma.Decimal('320.00'),
    tax: new Prisma.Decimal('60.00'),
    type: DividendType.CASH,
    note: '中期分红',
    createdAt: new Date('2025-07-16T08:30:00.000Z'),
    security: { name: '贵州茅台', code: '600519' },
    ...overrides,
  };
}

const DTO: CreateDividendRecordDto = {
  securityId: SECURITY_ID,
  date: '2025-07-15',
  amount: '320.00',
  tax: '60.00',
  type: DividendType.CASH,
  note: '中期分红',
};

describe('DividendService', () => {
  let prisma: PrismaMock;
  let service: DividendService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new DividendService(prisma as unknown as PrismaService);
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

    it('findAll：组合不属于当前用户 → 404，且不查分红表', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.findAll(PORTFOLIO_ID, OTHER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.findMany).not.toHaveBeenCalled();
    });

    it('create：组合不属于当前用户 → 404，且不写入分红表', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.create(PORTFOLIO_ID, OTHER_USER_ID, DTO),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
      // 越权时连标的归属都不该继续查
      expect(prisma.security.findFirst).not.toHaveBeenCalled();
    });

    it('update：组合不属于当前用户 → 404，且不查记录、不更新', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.update(PORTFOLIO_ID, 'div-1', OTHER_USER_ID, { note: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.findFirst).not.toHaveBeenCalled();
      expect(prisma.dividendRecord.update).not.toHaveBeenCalled();
    });

    it('remove：组合不属于当前用户 → 404，且不删除任何记录', async () => {
      prisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(PORTFOLIO_ID, 'div-1', OTHER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.findFirst).not.toHaveBeenCalled();
      expect(prisma.dividendRecord.delete).not.toHaveBeenCalled();
    });

    it('remove：记录 id 存在但不在本组合下 → 404，不删除', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(PORTFOLIO_ID, 'div-other', USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.findFirst).toHaveBeenCalledWith({
        where: { id: 'div-other', portfolioId: PORTFOLIO_ID },
        select: { id: true },
      });
      expect(prisma.dividendRecord.delete).not.toHaveBeenCalled();
    });

    it('create：标的不属于该组合 → 404（防跨组合挂载），不写入', async () => {
      prisma.security.findFirst.mockResolvedValue(null);

      await expect(
        service.create(PORTFOLIO_ID, USER_ID, DTO),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.security.findFirst).toHaveBeenCalledWith({
        where: { id: SECURITY_ID, portfolioId: PORTFOLIO_ID },
        select: { id: true },
      });
      expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // create
  // =========================================================================
  describe('create', () => {
    it('落库字段正确（含 tax），金额以 Decimal 写入（NUMERIC(18,2) 口径）', async () => {
      prisma.dividendRecord.create.mockResolvedValue(makeRecord());

      const result = await service.create(PORTFOLIO_ID, USER_ID, DTO);

      const args = prisma.dividendRecord.create.mock.calls[0][0];
      expect(args.data.portfolioId).toBe(PORTFOLIO_ID);
      expect(args.data.securityId).toBe(SECURITY_ID);
      expect(args.data.type).toBe(DividendType.CASH);
      expect(args.data.note).toBe('中期分红');
      expect(args.data.amount.toString()).toBe('320');
      expect(args.data.tax.toString()).toBe('60');
      expect(args.data.date.toISOString().split('T')[0]).toBe('2025-07-15');

      // 响应：金额/税/净额均为 2 位小数字符串、日期 YYYY-MM-DD、带标的名称与代码
      expect(result.amount).toBe('320.00');
      expect(result.tax).toBe('60.00');
      expect(result.netAmount).toBe('260.00');
      expect(result.date).toBe('2025-07-15');
      expect(result.securityName).toBe('贵州茅台');
      expect(result.securityCode).toBe('600519');
    });

    it('tax 缺省时落 0，netAmount = amount（存量兼容 Q-1）', async () => {
      prisma.dividendRecord.create.mockResolvedValue(
        makeRecord({ tax: new Prisma.Decimal(0) }),
      );

      const result = await service.create(PORTFOLIO_ID, USER_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        amount: '320.00',
      });

      const args = prisma.dividendRecord.create.mock.calls[0][0];
      expect(args.data.tax.toString()).toBe('0');
      expect(result.tax).toBe('0.00');
      expect(result.netAmount).toBe('320.00');
    });

    it('type 缺省时落 CASH，note 缺省时落 null', async () => {
      prisma.dividendRecord.create.mockResolvedValue(
        makeRecord({ note: null }),
      );

      await service.create(PORTFOLIO_ID, USER_ID, {
        securityId: SECURITY_ID,
        date: '2025-07-15',
        amount: '10.00',
      });

      const args = prisma.dividendRecord.create.mock.calls[0][0];
      expect(args.data.type).toBe(DividendType.CASH);
      expect(args.data.note).toBeNull();
    });

    it.each(['0', '0.00', '-1.00'])(
      '金额 %s（≤ 0）→ 400，且不写入',
      async (amount) => {
        await expect(
          service.create(PORTFOLIO_ID, USER_ID, { ...DTO, amount }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
      },
    );

    it('金额非数字 → 400，且不写入', async () => {
      await expect(
        service.create(PORTFOLIO_ID, USER_ID, { ...DTO, amount: 'abc' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
    });

    it('所得税为负 → 400，且不写入', async () => {
      await expect(
        service.create(PORTFOLIO_ID, USER_ID, { ...DTO, tax: '-1.00' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
    });

    it('所得税非法 → 400，且不写入', async () => {
      await expect(
        service.create(PORTFOLIO_ID, USER_ID, { ...DTO, tax: 'abc' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
    });

    it('净额校验：tax > amount → 400「净额不能为负」，且不写入', async () => {
      await expect(
        service.create(PORTFOLIO_ID, USER_ID, {
          ...DTO,
          amount: '100.00',
          tax: '150.00',
        }),
      ).rejects.toThrow('净额不能为负');

      expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
    });

    it('净额恰为 0 合法（amount === tax）', async () => {
      prisma.dividendRecord.create.mockResolvedValue(
        makeRecord({
          amount: new Prisma.Decimal('100.00'),
          tax: new Prisma.Decimal('100.00'),
        }),
      );

      const result = await service.create(PORTFOLIO_ID, USER_ID, {
        ...DTO,
        amount: '100.00',
        tax: '100.00',
      });

      expect(result.netAmount).toBe('0.00');
    });

    it('C-08/D-02：写入分红不得触碰 cashFlow 表', async () => {
      prisma.dividendRecord.create.mockResolvedValue(makeRecord());

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

      const args = prisma.dividendRecord.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ portfolioId: PORTFOLIO_ID });
      expect(args.orderBy[0]).toEqual({ date: 'desc' });
    });

    it('传 securityId 时进入 where 过滤', async () => {
      await service.findAll(PORTFOLIO_ID, USER_ID, SECURITY_ID);

      const args = prisma.dividendRecord.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        portfolioId: PORTFOLIO_ID,
        securityId: SECURITY_ID,
      });
    });

    it('securityId 为空串时不过滤（避免误传空值查空集）', async () => {
      await service.findAll(PORTFOLIO_ID, USER_ID, '');

      const args = prisma.dividendRecord.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ portfolioId: PORTFOLIO_ID });
    });

    it('映射为响应结构：金额/税/净额字符串 + 日期 YYYY-MM-DD + 标的名称/代码', async () => {
      prisma.dividendRecord.findMany.mockResolvedValue([
        makeRecord(),
        makeRecord({
          id: 'div-2',
          amount: new Prisma.Decimal('12.5'),
          tax: new Prisma.Decimal(0),
          type: DividendType.STOCK_DIVIDEND,
          note: null,
        }),
      ]);

      const list = await service.findAll(PORTFOLIO_ID, USER_ID);

      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        id: 'div-1',
        portfolioId: PORTFOLIO_ID,
        securityId: SECURITY_ID,
        securityName: '贵州茅台',
        securityCode: '600519',
        date: '2025-07-15',
        amount: '320.00',
        tax: '60.00',
        netAmount: '260.00',
        type: DividendType.CASH,
        note: '中期分红',
        createdAt: '2025-07-16T08:30:00.000Z',
      });
      expect(list[1].amount).toBe('12.50');
      expect(list[1].tax).toBe('0.00');
      expect(list[1].netAmount).toBe('12.50');
      expect(list[1].type).toBe(DividendType.STOCK_DIVIDEND);
      expect(list[1].note).toBeNull();
    });

    it('存量记录无 tax 字段时防御回退 0（Q-1）', async () => {
      prisma.dividendRecord.findMany.mockResolvedValue([
        makeRecord({ tax: undefined }),
      ]);

      const list = await service.findAll(PORTFOLIO_ID, USER_ID);

      expect(list[0].tax).toBe('0.00');
      expect(list[0].netAmount).toBe('320.00');
    });

    it('空列表返回 []', async () => {
      prisma.dividendRecord.findMany.mockResolvedValue([]);

      await expect(service.findAll(PORTFOLIO_ID, USER_ID)).resolves.toEqual([]);
    });
  });

  // =========================================================================
  // update（增量设计 R-5 / C-3）
  // =========================================================================
  describe('update', () => {
    it('仅改 amount/tax：prisma.update data 只含变更字段，净额按新值校验并返回新响应', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(
        makeRecord({
          amount: new Prisma.Decimal('500.00'),
          tax: new Prisma.Decimal('100.00'),
        }),
      );

      const result = await service.update(PORTFOLIO_ID, 'div-1', USER_ID, {
        amount: '500.00',
        tax: '100.00',
      });

      // 校验 ownership + 记录存在
      expect(prisma.dividendRecord.findFirst).toHaveBeenCalledWith({
        where: { id: 'div-1', portfolioId: PORTFOLIO_ID },
        include: { security: { select: { name: true, code: true } } },
      });

      const data = prisma.dividendRecord.update.mock.calls[0][0].data;
      expect(data).toEqual({
        amount: expect.any(Prisma.Decimal),
        tax: expect.any(Prisma.Decimal),
      });
      expect(data.amount.toString()).toBe('500');
      expect(data.tax.toString()).toBe('100');

      expect(result.amount).toBe('500.00');
      expect(result.tax).toBe('100.00');
      expect(result.netAmount).toBe('400.00');
    });

    it('仅改 note：不触碰 amount/tax 字段，data 只含 note', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(
        makeRecord({ note: '改备注' }),
      );

      await service.update(PORTFOLIO_ID, 'div-1', USER_ID, {
        note: '改备注',
      });

      const data = prisma.dividendRecord.update.mock.calls[0][0].data;
      expect(data).toEqual({ note: '改备注' });
    });

    it('改 securityId 时走二级闸（标的必须属于同一组合）', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(
        makeRecord({ securityId: '22222222-2222-4222-8222-222222222222' }),
      );

      const newSecurityId = '22222222-2222-4222-8222-222222222222';
      await service.update(PORTFOLIO_ID, 'div-1', USER_ID, {
        securityId: newSecurityId,
      });

      expect(prisma.security.findFirst).toHaveBeenCalledWith({
        where: { id: newSecurityId, portfolioId: PORTFOLIO_ID },
        select: { id: true },
      });
    });

    it('改 securityId 但标的不属于该组合 → 404，不更新', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.security.findFirst.mockResolvedValue(null);

      await expect(
        service.update(PORTFOLIO_ID, 'div-1', USER_ID, {
          securityId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.update).not.toHaveBeenCalled();
    });

    it('记录不存在（或不属于本组合）→ 404，不更新', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.update(PORTFOLIO_ID, 'div-missing', USER_ID, { note: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.dividendRecord.update).not.toHaveBeenCalled();
    });

    it('更新后净额 < 0 → 400（例如 amount 100、tax 150）', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(
        makeRecord({ amount: new Prisma.Decimal('100.00'), tax: new Prisma.Decimal('60.00') }),
      );

      await expect(
        service.update(PORTFOLIO_ID, 'div-1', USER_ID, {
          tax: '150.00',
        }),
      ).rejects.toThrow('净额不能为负');

      expect(prisma.dividendRecord.update).not.toHaveBeenCalled();
    });

    it('不传 tax 时净额校验沿用现值（amount 320 − tax 60 = 260 ≥ 0 放行）', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(makeRecord());

      await expect(
        service.update(PORTFOLIO_ID, 'div-1', USER_ID, { note: '仅改备注' }),
      ).resolves.toBeDefined();

      expect(prisma.dividendRecord.update).toHaveBeenCalledTimes(1);
    });

    it('C-08/D-02：更新分红不得触碰 cashFlow 表', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(makeRecord());

      await service.update(PORTFOLIO_ID, 'div-1', USER_ID, { note: 'x' });

      expect(prisma.cashFlow.create).not.toHaveBeenCalled();
    });

    it('改 type 时落库（I-02 P0 修复：前端编辑分红携带 type 不再 400 且可修改类型）', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(
        makeRecord({ type: DividendType.STOCK_DIVIDEND }),
      );

      const result = await service.update(PORTFOLIO_ID, 'div-1', USER_ID, {
        type: DividendType.STOCK_DIVIDEND,
      });

      const data = prisma.dividendRecord.update.mock.calls[0][0].data;
      expect(data).toEqual({ type: DividendType.STOCK_DIVIDEND });
      expect(result.type).toBe(DividendType.STOCK_DIVIDEND);
    });

    it('不传 type 时 data 不含 type（避免误清空现有类型）', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue(makeRecord());
      prisma.dividendRecord.update.mockResolvedValue(makeRecord());

      await service.update(PORTFOLIO_ID, 'div-1', USER_ID, { note: 'x' });

      const data = prisma.dividendRecord.update.mock.calls[0][0].data;
      expect(data.type).toBeUndefined();
    });
  });

  // =========================================================================
  // remove
  // =========================================================================
  describe('remove', () => {
    it('归属校验通过后按 id 删除并返回 null', async () => {
      prisma.dividendRecord.findFirst.mockResolvedValue({ id: 'div-1' });

      await expect(
        service.remove(PORTFOLIO_ID, 'div-1', USER_ID),
      ).resolves.toBeNull();

      expect(prisma.dividendRecord.delete).toHaveBeenCalledWith({
        where: { id: 'div-1' },
      });
    });
  });
});
