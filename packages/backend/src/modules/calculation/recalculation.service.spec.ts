/**
 * 批量重算服务单元测试
 *
 * 测试 RecalculationService 的两个入口：
 * - recalculateFromDate：从指定日期起按升序逐日重算
 * - recalculateAll：从组合成立日（第一笔买入日）全量重算
 *
 * 通过 mock PrismaService 与 CalculationService 隔离外部依赖。
 *
 * 关注点：
 * 1. 必须按日期【升序】逐日调用（净值有前日依赖，顺序错误会导致结转错乱）
 * 2. 起始日无快照时不能中断，其后有快照的日期仍须重算（补录历史交易场景）
 * 3. recalculateAll 必须复用 recalculateFromDate，而非另写一套遍历逻辑
 */

import { BadRequestException } from '@nestjs/common';
import { RecalculationService } from './recalculation.service';

/** 创建 Date 对象（使用 UTC 午夜，避免时区偏移） */
function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z');
}

function createMockPrisma() {
  return {
    assetSnapshot: {
      findMany: jest.fn(),
    },
    transaction: {
      findFirst: jest.fn(),
    },
  };
}

function createMockCalculation() {
  return {
    triggerCalculation: jest.fn().mockResolvedValue(undefined),
  };
}

describe('RecalculationService', () => {
  let service: RecalculationService;
  let mockPrisma: any;
  let mockCalculation: any;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    mockCalculation = createMockCalculation();
    service = new RecalculationService(mockPrisma, mockCalculation);
  });

  // ==========================================================
  // recalculateFromDate
  // ==========================================================
  describe('recalculateFromDate', () => {
    it('should recalculate every snapshot date in ascending order', async () => {
      const dates = [d('2024-01-02'), d('2024-01-03'), d('2024-01-04')];
      mockPrisma.assetSnapshot.findMany.mockResolvedValue(dates.map((date) => ({ date })));

      const result = await service.recalculateFromDate('p-1', d('2024-01-02'));

      expect(result.affectedDates).toBe(3);
      expect(mockCalculation.triggerCalculation).toHaveBeenCalledTimes(3);
      // 顺序必须严格升序
      expect(mockCalculation.triggerCalculation.mock.calls.map((c: any[]) => c[1])).toEqual(dates);
      // 查询必须带 orderBy asc
      expect(mockPrisma.assetSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { date: 'asc' } }),
      );
    });

    it('should query snapshots with date >= startDate (inclusive)', async () => {
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([]);

      await service.recalculateFromDate('p-1', d('2024-05-10'));

      expect(mockPrisma.assetSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { portfolioId: 'p-1', date: { gte: d('2024-05-10') } },
        }),
      );
    });

    it('should apply endDate as an inclusive upper bound when provided', async () => {
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([]);

      await service.recalculateFromDate('p-1', d('2024-05-10'), d('2024-05-20'));

      expect(mockPrisma.assetSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            portfolioId: 'p-1',
            date: { gte: d('2024-05-10'), lte: d('2024-05-20') },
          },
        }),
      );
    });

    it('should return 0 and trigger nothing when no snapshot exists in range', async () => {
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([]);

      const result = await service.recalculateFromDate('p-1', d('2024-01-01'));

      expect(result.affectedDates).toBe(0);
      expect(mockCalculation.triggerCalculation).not.toHaveBeenCalled();
    });

    it('should still recalculate later dates when the start date itself has no snapshot', async () => {
      // 补录 2024-03-01 的历史交易，但该日无快照，其后 3/05、3/08 有快照
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([
        { date: d('2024-03-05') },
        { date: d('2024-03-08') },
      ]);

      const result = await service.recalculateFromDate('p-1', d('2024-03-01'));

      expect(result.affectedDates).toBe(2);
      expect(mockCalculation.triggerCalculation).toHaveBeenCalledTimes(2);
      expect(mockCalculation.triggerCalculation).toHaveBeenNthCalledWith(1, 'p-1', d('2024-03-05'));
      expect(mockCalculation.triggerCalculation).toHaveBeenNthCalledWith(2, 'p-1', d('2024-03-08'));
    });

    it('should propagate errors raised by triggerCalculation', async () => {
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([{ date: d('2024-01-02') }]);
      mockCalculation.triggerCalculation.mockRejectedValue(new BadRequestException('计算失败'));

      await expect(service.recalculateFromDate('p-1', d('2024-01-01'))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ==========================================================
  // recalculateAll
  // ==========================================================
  describe('recalculateAll', () => {
    it('should recalculate from the first BUY date to the latest snapshot', async () => {
      const inception = d('2024-07-01');
      mockPrisma.transaction.findFirst.mockResolvedValue({ date: inception });
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([
        { date: d('2024-07-01') },
        { date: d('2024-07-15') },
        { date: d('2024-07-31') },
      ]);

      const result = await service.recalculateAll('p-1');

      expect(result.fromDate).toEqual(inception);
      expect(result.affectedDays).toBe(3);
      // 成立日取第一笔 BUY（升序第一条）
      expect(mockPrisma.transaction.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { portfolioId: 'p-1', type: 'BUY' },
          orderBy: { date: 'asc' },
        }),
      );
      // 复用 recalculateFromDate：不传 endDate（重算到最新）
      expect(mockPrisma.assetSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { portfolioId: 'p-1', date: { gte: inception } },
          orderBy: { date: 'asc' },
        }),
      );
      expect(mockCalculation.triggerCalculation).toHaveBeenCalledTimes(3);
    });

    it('should throw BadRequestException when the portfolio has no BUY transaction', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue(null);

      await expect(service.recalculateAll('p-1')).rejects.toThrow(BadRequestException);
      expect(mockCalculation.triggerCalculation).not.toHaveBeenCalled();
    });

    it('should return affectedDays=0 when the portfolio has no snapshot yet', async () => {
      const inception = d('2024-07-01');
      mockPrisma.transaction.findFirst.mockResolvedValue({ date: inception });
      mockPrisma.assetSnapshot.findMany.mockResolvedValue([]);

      const result = await service.recalculateAll('p-1');

      expect(result.fromDate).toEqual(inception);
      expect(result.affectedDays).toBe(0);
      expect(mockCalculation.triggerCalculation).not.toHaveBeenCalled();
    });
  });
});
