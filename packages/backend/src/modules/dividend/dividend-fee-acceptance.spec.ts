/**
 * 阶段 C 验收补充测试（QA 严过关 · Q-1 A 恢复 Dividend/Fee 两模块）
 *
 * 工程师自带的 dividend.service.spec / fee.service.spec 覆盖的是 **service 层**；
 * 本文件补齐三处覆盖缺口，均为主理人点名的高优先级验收项：
 *
 * 1. **6 个端点逐个 404**（验收 1）：走真实 Controller → 真实 Service → mock Prisma，
 *    验证 GET/POST/DELETE × dividends/fees 在越权时抛 404（而非 403/200），
 *    避免通过状态码泄露「该 portfolioId 是否存在」。
 * 2. **三张表零触碰**（验收 2 / D-02 / D-03）：原 spec 只断言了 create 路径的 cashFlow，
 *    此处把 daily_nav / daily_xirr / cash_flows 三张表 × create/delete 两条路径
 *    × dividend/fee 两个模块全部铺满，并从依赖注入层实锤未引入 RecalculationService。
 * 3. **金额精度双闸**（验收 4）：DTO 层（class-validator）+ Service 层（Decimal）
 *    对「≤ 0」「> 2 位小数」的拒绝，以及 NUMERIC(18,2) 字符串链路的无损传输。
 *
 * 说明：prisma 全量 mock，不触库；不依赖 Nest 容器，直接 new 出被测类。
 */

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, DividendType, FeeType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DividendService } from './dividend.service';
import { DividendController } from './dividend.controller';
import { DividendModule } from './dividend.module';
import { CreateDividendRecordDto } from './dto/create-dividend-record.dto';

import { FeeService } from '../fee/fee.service';
import { FeeController } from '../fee/fee.controller';
import { FeeModule } from '../fee/fee.module';
import { CreateFeeRecordDto } from '../fee/dto/create-fee-record.dto';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

// ---------------------------------------------------------------------------
// 固定装置
// ---------------------------------------------------------------------------

/** 用户 A（攻击者，持有合法 JWT） */
const USER_A: AuthenticatedUser = { userId: 'user-a', email: 'a@test.com' };
/** 用户 B 的组合 ID —— A 不得访问 */
const PORTFOLIO_OF_B = 'pf-belongs-to-b';
/** 用户 A 自己的组合 */
const PORTFOLIO_OF_A = 'pf-belongs-to-a';

const SECURITY_ID = '11111111-1111-4111-8111-111111111111';
/** 属于「他组合」的标的 —— 用于跨组合挂载攻击 */
const FOREIGN_SECURITY_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';

/**
 * 构造 prisma mock。
 *
 * 关键：把 **daily_nav / daily_xirr / cash_flows** 三张「收益计算结果表」
 * 一并挂上侦听，任何一次调用都会被下方断言抓到。
 */
function createPrismaMock() {
  return {
    portfolio: { findFirst: jest.fn().mockResolvedValue({ id: PORTFOLIO_OF_A }) },
    security: { findFirst: jest.fn().mockResolvedValue({ id: SECURITY_ID }) },
    dividendRecord: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: RECORD_ID }),
      delete: jest.fn().mockResolvedValue({ id: RECORD_ID }),
    },
    feeRecord: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: RECORD_ID }),
      delete: jest.fn().mockResolvedValue({ id: RECORD_ID }),
    },
    // ↓↓↓ 三张「不得被污染」的表 ↓↓↓
    cashFlow: {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    dailyNav: {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    dailyXirr: {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    assetSnapshot: { create: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

const DIVIDEND_DTO: CreateDividendRecordDto = {
  securityId: SECURITY_ID,
  date: '2025-07-15',
  amount: '320.00',
  type: DividendType.CASH,
  note: '中期分红',
};

const FEE_DTO: CreateFeeRecordDto = {
  securityId: SECURITY_ID,
  date: '2025-08-01',
  amount: '5.00',
  type: FeeType.COMMISSION,
};

function makeDividendRecord(amount = '320.00') {
  return {
    id: RECORD_ID,
    portfolioId: PORTFOLIO_OF_A,
    securityId: SECURITY_ID,
    date: new Date('2025-07-15T00:00:00.000Z'),
    amount: new Prisma.Decimal(amount),
    type: DividendType.CASH,
    note: null,
    createdAt: new Date('2025-07-16T08:30:00.000Z'),
    security: { name: '甲股票', code: '600000' },
  };
}

function makeFeeRecord(amount = '5.00') {
  return {
    id: RECORD_ID,
    portfolioId: PORTFOLIO_OF_A,
    securityId: SECURITY_ID,
    date: new Date('2025-08-01T00:00:00.000Z'),
    amount: new Prisma.Decimal(amount),
    type: FeeType.COMMISSION,
    transactionId: null,
    note: null,
    createdAt: new Date('2025-08-02T08:30:00.000Z'),
    security: { name: '甲股票', code: '600000' },
  };
}

/**
 * 断言：三张收益计算表的**任何**方法都没有被调用过。
 *
 * 收集所有被调用的 `表.方法` 并一次性比对空数组 —— 失败时能直接看到
 * 是哪张表的哪个方法被污染了（Jest 的 expect 不支持自定义消息参数）。
 */
function expectIncomeTablesUntouched(prisma: PrismaMock): void {
  const touched: string[] = [];
  for (const table of ['cashFlow', 'dailyNav', 'dailyXirr'] as const) {
    for (const [method, fn] of Object.entries(prisma[table])) {
      if ((fn as jest.Mock).mock.calls.length > 0) {
        touched.push(`prisma.${table}.${method}`);
      }
    }
  }
  // 期望为空：非空即违反 D-02 / D-03
  expect(touched).toEqual([]);
}

// ===========================================================================
// 验收 1：user_id 隔离 —— 6 个端点逐个 404
// ===========================================================================
describe('[验收1] user_id 隔离：6 个端点越权访问一律 404', () => {
  let prisma: PrismaMock;
  let dividendController: DividendController;
  let feeController: FeeController;

  beforeEach(() => {
    prisma = createPrismaMock();
    // 用户 A 拿着合法 JWT 去访问用户 B 的组合 → 组合归属查询查不到
    prisma.portfolio.findFirst.mockResolvedValue(null);

    dividendController = new DividendController(
      new DividendService(prisma as unknown as PrismaService),
    );
    feeController = new FeeController(
      new FeeService(prisma as unknown as PrismaService),
    );
  });

  /** 6 个端点的调用器（在 beforeEach 之后取控制器实例，故用惰性函数） */
  const ENDPOINTS: Array<[name: string, invoke: () => Promise<unknown>]> = [
    [
      'GET /portfolios/:id/dividends',
      () => dividendController.findAll(USER_A, PORTFOLIO_OF_B),
    ],
    [
      'POST /portfolios/:id/dividends',
      () => dividendController.create(USER_A, PORTFOLIO_OF_B, DIVIDEND_DTO),
    ],
    [
      'DELETE /portfolios/:id/dividends/:recordId',
      () => dividendController.remove(USER_A, PORTFOLIO_OF_B, RECORD_ID),
    ],
    [
      'GET /portfolios/:id/fees',
      () => feeController.findAll(USER_A, PORTFOLIO_OF_B),
    ],
    [
      'POST /portfolios/:id/fees',
      () => feeController.create(USER_A, PORTFOLIO_OF_B, FEE_DTO),
    ],
    [
      'DELETE /portfolios/:id/fees/:recordId',
      () => feeController.remove(USER_A, PORTFOLIO_OF_B, RECORD_ID),
    ],
  ];

  // 每个端点独立成例：失败时能一眼定位是哪个端点漏闸
  describe.each(ENDPOINTS)('%s', (_name, invoke) => {
    it('抛 NotFoundException 且状态码严格为 404（非 403 / 非 200）', async () => {
      let caught: unknown;
      try {
        await invoke();
      } catch (e) {
        caught = e;
      }

      // 未抛异常 = 越权返回了 200，直接泄露他人数据
      expect(caught).toBeInstanceOf(NotFoundException);
      // 403 会暴露「资源存在但你没权限」，必须是 404
      expect((caught as NotFoundException).getStatus()).toBe(404);
    });

    it('以 { id, userId } 双条件查组合（隔离闸生效）', async () => {
      await expect(invoke()).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.portfolio.findFirst).toHaveBeenCalledWith({
        where: { id: PORTFOLIO_OF_B, userId: USER_A.userId },
        select: { id: true },
      });
    });

    it('未触达任何记录表（无读、无写、无删）', async () => {
      await expect(invoke()).rejects.toBeInstanceOf(NotFoundException);

      const touched: string[] = [];
      for (const table of ['dividendRecord', 'feeRecord'] as const) {
        for (const [method, fn] of Object.entries(prisma[table])) {
          if ((fn as jest.Mock).mock.calls.length > 0) {
            touched.push(`prisma.${table}.${method}`);
          }
        }
      }
      expect(touched).toEqual([]);
    });

    it('错误文案不泄露资源存在性（不含组合 ID / 记录 ID）', async () => {
      let caught: NotFoundException | undefined;
      try {
        await invoke();
      } catch (e) {
        caught = e as NotFoundException;
      }
      const message = caught?.message ?? '';
      expect(message).not.toContain(PORTFOLIO_OF_B);
      expect(message).not.toContain(RECORD_ID);
    });
  });
});

// ===========================================================================
// 验收 1（续）：跨组合挂载标的
// ===========================================================================
describe('[验收1] 二级闸：跨组合挂载标的被拒', () => {
  let prisma: PrismaMock;
  let dividendController: DividendController;
  let feeController: FeeController;

  beforeEach(() => {
    prisma = createPrismaMock();
    // 组合归属通过（是自己的组合），但标的属于别的组合
    prisma.portfolio.findFirst.mockResolvedValue({ id: PORTFOLIO_OF_A });
    prisma.security.findFirst.mockResolvedValue(null);

    dividendController = new DividendController(
      new DividendService(prisma as unknown as PrismaService),
    );
    feeController = new FeeController(
      new FeeService(prisma as unknown as PrismaService),
    );
  });

  it('POST dividends：securityId 属于他组合 → 404，且不写入', async () => {
    await expect(
      dividendController.create(USER_A, PORTFOLIO_OF_A, {
        ...DIVIDEND_DTO,
        securityId: FOREIGN_SECURITY_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.security.findFirst).toHaveBeenCalledWith({
      where: { id: FOREIGN_SECURITY_ID, portfolioId: PORTFOLIO_OF_A },
      select: { id: true },
    });
    expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
  });

  it('POST fees：securityId 属于他组合 → 404，且不写入', async () => {
    await expect(
      feeController.create(USER_A, PORTFOLIO_OF_A, {
        ...FEE_DTO,
        securityId: FOREIGN_SECURITY_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.feeRecord.create).not.toHaveBeenCalled();
  });

  it('跨组合挂载被拒时状态码同样是 404（不泄露标的存在性）', async () => {
    for (const invoke of [
      () =>
        dividendController.create(USER_A, PORTFOLIO_OF_A, {
          ...DIVIDEND_DTO,
          securityId: FOREIGN_SECURITY_ID,
        }),
      () =>
        feeController.create(USER_A, PORTFOLIO_OF_A, {
          ...FEE_DTO,
          securityId: FOREIGN_SECURITY_ID,
        }),
    ]) {
      let caught: NotFoundException | undefined;
      try {
        await invoke();
      } catch (e) {
        caught = e as NotFoundException;
      }
      expect(caught?.getStatus()).toBe(404);
    }
  });
});

// ===========================================================================
// 验收 2：不污染收益计算（D-02 / D-03）
// ===========================================================================
describe('[验收2] 不污染收益计算：daily_nav / daily_xirr / cash_flows 零触碰', () => {
  let prisma: PrismaMock;
  let dividendService: DividendService;
  let feeService: FeeService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.dividendRecord.create.mockResolvedValue(makeDividendRecord());
    prisma.feeRecord.create.mockResolvedValue(makeFeeRecord());
    dividendService = new DividendService(prisma as unknown as PrismaService);
    feeService = new FeeService(prisma as unknown as PrismaService);
  });

  it('新增分红后，三张表均无任何调用', async () => {
    await dividendService.create(PORTFOLIO_OF_A, USER_A.userId, DIVIDEND_DTO);
    expectIncomeTablesUntouched(prisma);
  });

  it('删除分红后，三张表均无任何调用', async () => {
    await dividendService.remove(PORTFOLIO_OF_A, RECORD_ID, USER_A.userId);
    expect(prisma.dividendRecord.delete).toHaveBeenCalledTimes(1);
    expectIncomeTablesUntouched(prisma);
  });

  it('新增费用后，三张表均无任何调用', async () => {
    await feeService.create(PORTFOLIO_OF_A, USER_A.userId, FEE_DTO);
    expectIncomeTablesUntouched(prisma);
  });

  it('删除费用后，三张表均无任何调用', async () => {
    await feeService.remove(PORTFOLIO_OF_A, RECORD_ID, USER_A.userId);
    expect(prisma.feeRecord.delete).toHaveBeenCalledTimes(1);
    expectIncomeTablesUntouched(prisma);
  });

  it('分红/费用写入均未开启事务（不与重算流程耦合）', async () => {
    await dividendService.create(PORTFOLIO_OF_A, USER_A.userId, DIVIDEND_DTO);
    await feeService.create(PORTFOLIO_OF_A, USER_A.userId, FEE_DTO);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('依赖注入实锤：两个 Service 的构造参数只有 PrismaService（未注入 RecalculationService）', () => {
    for (const target of [DividendService, FeeService]) {
      const paramTypes: unknown[] =
        Reflect.getMetadata('design:paramtypes', target) ?? [];
      expect(paramTypes).toHaveLength(1);
      expect(paramTypes[0]).toBe(PrismaService);
    }
  });

  it('模块元数据实锤：两个 Module 未 import 任何重算/计算模块', () => {
    for (const mod of [DividendModule, FeeModule]) {
      const imports: unknown[] = Reflect.getMetadata('imports', mod) ?? [];
      const names = imports.map((m) => (m as { name?: string })?.name ?? '');
      // 列出违规项而非布尔值：失败时直接显示是哪个模块被引入
      expect(
        names.filter((n) => /Recalculation|Calculation/i.test(n)),
      ).toEqual([]);

      const providers: unknown[] = Reflect.getMetadata('providers', mod) ?? [];
      const providerNames = providers.map(
        (p) => (p as { name?: string })?.name ?? '',
      );
      expect(
        providerNames.filter((n) => /Recalculation|Calculation/i.test(n)),
      ).toEqual([]);
    }
  });
});

// ===========================================================================
// 验收 4：金额精度 —— DTO 层 + Service 层双闸
// ===========================================================================
describe('[验收4] 金额精度：NUMERIC(18,2) 双闸校验', () => {
  let prisma: PrismaMock;
  let dividendService: DividendService;
  let feeService: FeeService;

  beforeEach(() => {
    prisma = createPrismaMock();
    dividendService = new DividendService(prisma as unknown as PrismaService);
    feeService = new FeeService(prisma as unknown as PrismaService);
  });

  /** 跑一遍 class-validator，返回 amount 字段的报错数量（分红 DTO） */
  async function validateDividendAmount(amount: string): Promise<number> {
    const instance = plainToInstance(CreateDividendRecordDto, {
      ...DIVIDEND_DTO,
      amount,
    });
    const errors = await validate(instance);
    return errors.filter((e) => e.property === 'amount').length;
  }

  /** 跑一遍 class-validator，返回 amount 字段的报错数量（费用 DTO） */
  async function validateFeeAmount(amount: string): Promise<number> {
    const instance = plainToInstance(CreateFeeRecordDto, {
      ...FEE_DTO,
      amount,
    });
    const errors = await validate(instance);
    return errors.filter((e) => e.property === 'amount').length;
  }

  describe('DTO 层（class-validator）', () => {
    it.each(['1.234', '0.001', '99.999'])(
      '超过 2 位小数被拒：%s',
      async (amount) => {
        expect(await validateDividendAmount(amount)).toBe(1);
        expect(await validateFeeAmount(amount)).toBe(1);
      },
    );

    it.each(['0.30', '320.00', '100', '0.1'])(
      '合法金额通过：%s',
      async (amount) => {
        expect(await validateDividendAmount(amount)).toBe(0);
        expect(await validateFeeAmount(amount)).toBe(0);
      },
    );

    it('非数字字符串被拒', async () => {
      expect(await validateDividendAmount('abc')).toBe(1);
      expect(await validateFeeAmount('12e5')).toBe(1);
    });
  });

  describe('Service 层（Prisma.Decimal）', () => {
    it.each(['0', '0.00', '-0.01', '-100.00'])(
      '金额 ≤ 0 被拒（400）且不写入：%s',
      async (amount) => {
        await expect(
          dividendService.create(PORTFOLIO_OF_A, USER_A.userId, {
            ...DIVIDEND_DTO,
            amount,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          feeService.create(PORTFOLIO_OF_A, USER_A.userId, {
            ...FEE_DTO,
            amount,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.dividendRecord.create).not.toHaveBeenCalled();
        expect(prisma.feeRecord.create).not.toHaveBeenCalled();
      },
    );

    it('≤ 0 抛出的状态码是 400（而非 500）', async () => {
      let caught: BadRequestException | undefined;
      try {
        await dividendService.create(PORTFOLIO_OF_A, USER_A.userId, {
          ...DIVIDEND_DTO,
          amount: '0',
        });
      } catch (e) {
        caught = e as BadRequestException;
      }
      expect(caught?.getStatus()).toBe(400);
    });

    it('金额以 Decimal 写库，不经过 JS number（避免丢精）', async () => {
      prisma.dividendRecord.create.mockResolvedValue(makeDividendRecord());
      await dividendService.create(PORTFOLIO_OF_A, USER_A.userId, {
        ...DIVIDEND_DTO,
        amount: '12345678901234.56',
      });

      const args = prisma.dividendRecord.create.mock.calls[0][0];
      expect(args.data.amount).toBeInstanceOf(Prisma.Decimal);
      expect(args.data.amount.toString()).toBe('12345678901234.56');
    });
  });

  describe('全链路字符串传输（无浮点毛刺）', () => {
    it('0.10 + 0.20 用 Decimal 精确求和 = 0.3（后端侧无 0.30000000000000004）', () => {
      const sum = new Prisma.Decimal('0.10').plus(new Prisma.Decimal('0.20'));
      expect(sum.toFixed(2)).toBe('0.30');
      // 反证：JS number 会产生毛刺
      expect(0.1 + 0.2).not.toBe(0.3);
    });

    it('响应体 amount 始终是字符串类型（不被 JSON 序列化成 number）', async () => {
      prisma.dividendRecord.findMany.mockResolvedValue([
        makeDividendRecord('0.10'),
        makeDividendRecord('0.20'),
      ]);
      const list = await dividendService.findAll(
        PORTFOLIO_OF_A,
        USER_A.userId,
      );

      for (const item of list) {
        expect(typeof item.amount).toBe('string');
      }
      // 前端 formatCurrency(…, 2) 会补齐两位小数，此处只保证数值等价
      expect(Number(list[0].amount)).toBeCloseTo(0.1, 10);
      expect(Number(list[1].amount)).toBeCloseTo(0.2, 10);
    });

    it('大额金额不丢精（18 位整数部分）', async () => {
      prisma.feeRecord.findMany.mockResolvedValue([
        makeFeeRecord('9999999999999999.99'),
      ]);
      const list = await feeService.findAll(PORTFOLIO_OF_A, USER_A.userId);
      expect(list[0].amount).toBe('9999999999999999.99');
    });
  });
});
