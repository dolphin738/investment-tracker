/**
 * 组合归档 / 删除 —— 归档态回传与悬垂默认组合清理 回归测试
 *
 * 覆盖两个缺陷：
 * - Bug 4「组合归档无效」：archive 成功但响应里没有 archivedAt，
 *   前端拿不到归档态，自然没法把归档组合从选择器里隐藏。
 * - Bug 6 的服务端一半：defaultPortfolioId 列没有外键约束，
 *   组合被归档 / 删除后偏好里会残留悬垂 ID，必须同步置空。
 *
 * 说明：prisma 与 recalculationService 全部 mock，不触库。
 */

import 'reflect-metadata';
import { PortfolioService } from './portfolio.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RecalculationService } from '../recalculation/recalculation.service';

const USER_ID = 'user-1';
const PORTFOLIO_ID = '11111111-2222-3333-4444-555555555555';

/** 一条组合行（Prisma 返回结构的最小子集） */
function makePortfolioRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PORTFOLIO_ID,
    userId: USER_ID,
    name: '主组合',
    description: null,
    baseDate: null,
    currency: 'CNY',
    archivedAt: null as Date | null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function createMockPrisma() {
  return {
    portfolio: {
      findFirst: jest.fn(async () => makePortfolioRow()),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        makePortfolioRow(data),
      ),
      delete: jest.fn(async () => makePortfolioRow()),
    },
    userPreference: {
      updateMany: jest.fn(
        async (_args: {
          where: { userId: string; defaultPortfolioId: string };
          data: { defaultPortfolioId: null };
        }) => ({ count: 1 }),
      ),
    },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

function createService(): { service: PortfolioService; prisma: MockPrisma } {
  const prisma = createMockPrisma();
  const recalculation = {} as RecalculationService;
  const service = new PortfolioService(
    prisma as unknown as PrismaService,
    recalculation,
  );
  return { service, prisma };
}

// ============================================================
// Bug 4：归档态必须回传给前端
// ============================================================

describe('PortfolioService.archive — 归档态回传（Bug 4）', () => {
  it('归档后响应必须包含 ISO 格式的 archivedAt', async () => {
    const { service } = createService();

    const result = await service.archive(USER_ID, PORTFOLIO_ID, {
      archived: true,
    });

    expect(result.archivedAt).not.toBeNull();
    // ISO 8601，前端 !p.archivedAt 判断才能稳定工作
    expect(typeof result.archivedAt).toBe('string');
    expect(new Date(result.archivedAt as string).toString()).not.toBe(
      'Invalid Date',
    );
  });

  it('取消归档后 archivedAt 应为 null（而不是缺字段）', async () => {
    const { service, prisma } = createService();

    const result = await service.archive(USER_ID, PORTFOLIO_ID, {
      archived: false,
    });

    expect(prisma.portfolio.update).toHaveBeenCalledWith({
      where: { id: PORTFOLIO_ID },
      data: { archivedAt: null },
    });
    expect(result.archivedAt).toBeNull();
  });

  it('archived 缺省时按「归档」处理（保持既有语义）', async () => {
    const { service, prisma } = createService();

    await service.archive(USER_ID, PORTFOLIO_ID, {} as { archived?: boolean });

    const call = prisma.portfolio.update.mock.calls[0][0] as {
      data: { archivedAt: Date | null };
    };
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });
});

// ============================================================
// Bug 6：归档 / 删除时清理悬垂的 defaultPortfolioId
// ============================================================

describe('PortfolioService — 悬垂默认组合清理（Bug 6）', () => {
  it('归档组合时应把「正好是该组合」的默认组合置空', async () => {
    const { service, prisma } = createService();

    await service.archive(USER_ID, PORTFOLIO_ID, { archived: true });

    expect(prisma.userPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, defaultPortfolioId: PORTFOLIO_ID },
      data: { defaultPortfolioId: null },
    });
  });

  it('取消归档不应误清默认组合', async () => {
    const { service, prisma } = createService();

    await service.archive(USER_ID, PORTFOLIO_ID, { archived: false });

    expect(prisma.userPreference.updateMany).not.toHaveBeenCalled();
  });

  it('删除组合时同样要清空悬垂默认组合', async () => {
    const { service, prisma } = createService();

    await service.remove(USER_ID, PORTFOLIO_ID);

    expect(prisma.portfolio.delete).toHaveBeenCalledWith({
      where: { id: PORTFOLIO_ID },
    });
    expect(prisma.userPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, defaultPortfolioId: PORTFOLIO_ID },
      data: { defaultPortfolioId: null },
    });
  });

  it('清理必须带 userId 条件，不能误伤其他用户的偏好', async () => {
    const { service, prisma } = createService();

    await service.remove(USER_ID, PORTFOLIO_ID);

    expect(prisma.userPreference.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      }),
    );
  });
});
