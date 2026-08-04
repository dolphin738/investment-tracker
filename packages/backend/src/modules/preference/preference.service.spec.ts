/**
 * 用户偏好 —— 「默认组合」失效链路回归测试
 *
 * 背景（Bug 6）：把当前默认组合归档后，再去设置页重设默认组合，
 * 前端只会拿到一句 `defaultPortfolioId must be a UUID`，用户完全无从下手。
 * 根因有三段，本文件逐段锁死：
 *
 * 1. DTO 层：前端「不设置」在表单里天然是空串 ''，直接透传会被 @IsUUID 判 400。
 *    修复为 @Transform 空串 → null，让「清空」与「设置」走同一条通路。
 * 2. GET 自愈：默认组合可能已被删除 / 归档（归档组合已从选择器隐藏），
 *    继续回传失效 ID 会让前端一直带着一个选不回来的旧值 → 就地置空。
 * 3. PATCH 校验：默认组合必须「属于本人 + 存在 + 未归档」，
 *    否则抛可读的 BadRequest，而不是让用户看 class-validator 的 UUID 报错。
 *
 * 说明：prisma 全部 mock，测试不触库、可并行、幂等。
 */

import 'reflect-metadata';
import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { PreferenceService } from './preference.service';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import type { PrismaService } from '../../prisma/prisma.service';

const USER_ID = 'user-1';
// 必须是 RFC 4122 合法 UUID（版本位 4、变体位 8/9/a/b），
// 否则 @IsUUID() 会先一步拒掉，测的就不是我们想测的东西了。
// Prisma 的 @default(uuid()) 产出的正是 v4，与这里保持一致。
const PORTFOLIO_ID = '3f1c9b0e-7a3d-4f6b-9c2e-5d8a1b0c3e4f';
const OTHER_PORTFOLIO_ID = 'a2b4c6d8-1234-4abc-9def-0123456789ab';

/** 一条完整的偏好行（Prisma 返回结构的最小子集） */
function makePrefRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-1',
    userId: USER_ID,
    defaultPortfolioId: null as string | null,
    defaultGranularity: 'month',
    defaultDateRange: '1y',
    aggregation: 'last',
    weekStartsOn: 1,
    navDecimals: 4,
    xirrDecimals: 2,
    theme: 'system',
    staleDays: 3,
    // Gap C：软提示 / 金额格式（PRD §6.9.1 / §7.8 默认 true/true/true/false）
    cashHintOnCashflow: true,
    cashHintOnTrade: true,
    amountThousands: true,
    amountAbbrev: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function createMockPrisma() {
  return {
    userPreference: {
      findUnique: jest.fn(async () => makePrefRow()),
      create: jest.fn(async () => makePrefRow()),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        makePrefRow(data),
      ),
    },
    // 默认：查不到「可选组合」（即组合不存在 / 已归档 / 不属于本人）
    portfolio: {
      findFirst: jest.fn(async () => null as { id: string } | null),
    },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

function createService(): { service: PreferenceService; prisma: MockPrisma } {
  const prisma = createMockPrisma();
  const service = new PreferenceService(prisma as unknown as PrismaService);
  return { service, prisma };
}

// ============================================================
// 1. DTO 层：空串 → null（Bug 6 的直接触发点）
// ============================================================

describe('UpdatePreferenceDto — defaultPortfolioId 空值归一', () => {
  // 与 packages/backend/src/main.ts 保持一致
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta: ArgumentMetadata = {
    type: 'body',
    metatype: UpdatePreferenceDto,
    data: '',
  };

  it('空串应被转成 null 而不是抛 “must be a UUID”', async () => {
    const dto = (await pipe.transform(
      { defaultPortfolioId: '' },
      meta,
    )) as UpdatePreferenceDto;
    expect(dto.defaultPortfolioId).toBeNull();
  });

  it('纯空白串同样归一为 null', async () => {
    const dto = (await pipe.transform(
      { defaultPortfolioId: '   ' },
      meta,
    )) as UpdatePreferenceDto;
    expect(dto.defaultPortfolioId).toBeNull();
  });

  it('显式 null 直接放行（清空默认组合）', async () => {
    const dto = (await pipe.transform(
      { defaultPortfolioId: null },
      meta,
    )) as UpdatePreferenceDto;
    expect(dto.defaultPortfolioId).toBeNull();
  });

  it('合法 UUID 原样通过', async () => {
    const dto = (await pipe.transform(
      { defaultPortfolioId: PORTFOLIO_ID },
      meta,
    )) as UpdatePreferenceDto;
    expect(dto.defaultPortfolioId).toBe(PORTFOLIO_ID);
  });

  it('非空的非 UUID 仍必须被拒（不能因为放行空串就把校验放没了）', async () => {
    await expect(
      pipe.transform({ defaultPortfolioId: 'not-a-uuid' }, meta),
    ).rejects.toThrow();
  });

  it('字段缺省时不校验（PATCH 语义：不传 = 不修改）', async () => {
    const dto = (await pipe.transform({ theme: 'dark' }, meta)) as UpdatePreferenceDto;
    expect(dto.defaultPortfolioId).toBeUndefined();
    expect(dto.theme).toBe('dark');
  });
});

// ============================================================
// 2. GET 自愈：失效的默认组合就地清空
// ============================================================

describe('PreferenceService.get — 失效默认组合自愈', () => {
  it('默认组合已归档 / 已删除时，GET 应把它清空并回传 null', async () => {
    const { service, prisma } = createService();
    prisma.userPreference.findUnique.mockResolvedValueOnce(
      makePrefRow({ defaultPortfolioId: PORTFOLIO_ID }) as never,
    );
    // portfolio.findFirst 默认返回 null → 视为不可选

    const result = await service.get(USER_ID);

    expect(prisma.userPreference.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { defaultPortfolioId: null },
    });
    expect(result.defaultPortfolioId).toBeNull();
  });

  it('自愈查询必须带 archivedAt: null（归档组合不算有效默认组合）', async () => {
    const { service, prisma } = createService();
    prisma.userPreference.findUnique.mockResolvedValueOnce(
      makePrefRow({ defaultPortfolioId: PORTFOLIO_ID }) as never,
    );

    await service.get(USER_ID);

    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith({
      where: { id: PORTFOLIO_ID, userId: USER_ID, archivedAt: null },
      select: { id: true },
    });
  });

  it('默认组合仍然有效时不应触发任何写操作', async () => {
    const { service, prisma } = createService();
    prisma.userPreference.findUnique.mockResolvedValueOnce(
      makePrefRow({ defaultPortfolioId: PORTFOLIO_ID }) as never,
    );
    prisma.portfolio.findFirst.mockResolvedValueOnce({ id: PORTFOLIO_ID });

    const result = await service.get(USER_ID);

    expect(prisma.userPreference.update).not.toHaveBeenCalled();
    expect(result.defaultPortfolioId).toBe(PORTFOLIO_ID);
  });

  it('本来就没有默认组合时不做多余的组合查询', async () => {
    const { service, prisma } = createService();

    const result = await service.get(USER_ID);

    expect(prisma.portfolio.findFirst).not.toHaveBeenCalled();
    expect(prisma.userPreference.update).not.toHaveBeenCalled();
    expect(result.defaultPortfolioId).toBeNull();
  });
});

// ============================================================
// 3. PATCH 校验：只接受「属于本人 + 存在 + 未归档」的组合
// ============================================================

describe('PreferenceService.update — 默认组合校验', () => {
  it('指定已归档 / 不存在的组合应抛可读的 BadRequest，而不是 UUID 报错', async () => {
    const { service } = createService();

    await expect(
      service.update(USER_ID, { defaultPortfolioId: PORTFOLIO_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.update(USER_ID, { defaultPortfolioId: PORTFOLIO_ID }),
    ).rejects.toThrow('默认组合不存在、无权访问或已归档，请选择其他组合');
  });

  it('越权指定他人的组合同样被拒（数据隔离）', async () => {
    const { service, prisma } = createService();

    await expect(
      service.update(USER_ID, { defaultPortfolioId: OTHER_PORTFOLIO_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith({
      where: { id: OTHER_PORTFOLIO_ID, userId: USER_ID, archivedAt: null },
      select: { id: true },
    });
  });

  it('传 null 表示「不设置默认组合」，应放行并写入 null', async () => {
    const { service, prisma } = createService();

    const result = await service.update(USER_ID, { defaultPortfolioId: null });

    expect(prisma.portfolio.findFirst).not.toHaveBeenCalled();
    expect(prisma.userPreference.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { defaultPortfolioId: null },
    });
    expect(result.defaultPortfolioId).toBeNull();
  });

  it('组合有效时正常写入', async () => {
    const { service, prisma } = createService();
    prisma.portfolio.findFirst.mockResolvedValueOnce({ id: PORTFOLIO_ID });

    const result = await service.update(USER_ID, {
      defaultPortfolioId: PORTFOLIO_ID,
    });

    expect(result.defaultPortfolioId).toBe(PORTFOLIO_ID);
  });

  it('不涉及默认组合的更新（如切主题）不应被组合校验拦截', async () => {
    const { service, prisma } = createService();

    const result = await service.update(USER_ID, { theme: 'dark' });

    expect(prisma.portfolio.findFirst).not.toHaveBeenCalled();
    expect(result.theme).toBe('dark');
  });
});
