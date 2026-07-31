/**
 * 查询聚合服务单元测试
 *
 * 测试 QueryService 的四维度查询（日/周/月/年）和聚合方式（last/avg）。
 * 通过 mock PrismaService 隔离数据库依赖。
 *
 * 测试覆盖：
 * 1. day 维度：返回每日原始数据
 * 2. week 维度：按 ISO 周分组
 * 3. month 维度：按年-月分组
 * 4. year 维度：按年分组
 * 5. aggregation=last vs avg：验证两种聚合方式
 * 6. 空数据返回空数组
 * 7. null 值处理
 * 8. NAV 系列查询
 */

import {
  AggregationMethod,
  QueryGranularity,
} from '@investment-tracker/shared';
import { QueryService } from './query.service';

// ============================================================
// 辅助函数
// ============================================================

/** 创建 Date 对象（使用 UTC 午夜，避免时区偏移） */
function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00.000Z');
}

/** 创建 mock PrismaService */
function createMockPrisma() {
  return {
    portfolio: {
      findFirst: jest.fn(),
    },
    dailyXirr: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    dailyNav: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };
}

/** 创建模拟的 DailyXirr 记录 */
function makeXirrRecord(dateStr: string, xirrValue: number | null) {
  return { date: d(dateStr), xirrValue };
}

/** 创建模拟的 DailyNav 记录 */
function makeNavRecord(
  dateStr: string,
  cumulativeNav: number,
  yearNav: number,
  shares: number,
) {
  return { date: d(dateStr), cumulativeNav, yearNav, shares };
}

const USER_ID = 'user-1';
const PORTFOLIO_ID = 'portfolio-1';

// ============================================================
// 测试
// ============================================================

describe('QueryService', () => {
  let service: QueryService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new QueryService(mockPrisma);

    // 默认 ownership 校验通过
    mockPrisma.portfolio.findFirst.mockResolvedValue({ id: PORTFOLIO_ID });
  });

  // ============================================================
  // XIRR 查询
  // ============================================================
  describe('queryXirrSeries', () => {
    // ----------------------------------------------------------
    // 测试 1: day 维度 — 返回每日原始数据
    // ----------------------------------------------------------
    it('should return daily raw data for day granularity', async () => {
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-02', 0.11),
        makeXirrRecord('2024-01-03', 0.12),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.DAY,
      });

      expect(result).toHaveLength(3);
      expect(result[0].xirrValue).toBeCloseTo(0.10, 6);
      expect(result[0].date).toBe('2024-01-01');
      expect(result[0].label).toBe('2024-01-01');
      expect(result[1].xirrValue).toBeCloseTo(0.11, 6);
      expect(result[2].xirrValue).toBeCloseTo(0.12, 6);
    });

    // ----------------------------------------------------------
    // 测试 2: week 维度 — 按 ISO 周分组
    // ----------------------------------------------------------
    it('should group by ISO week for week granularity (last aggregation)', async () => {
      // 2024-01-01 是周一（ISO 周 1）
      // 2024-01-03 是周三（同周）
      // 2024-01-05 是周五（同周）
      // 2024-01-08 是下周一（ISO 周 2）
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-03', 0.11),
        makeXirrRecord('2024-01-05', 0.12),
        makeXirrRecord('2024-01-08', 0.13),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.WEEK,
        aggregation: AggregationMethod.LAST,
      });

      // 应分为 2 组（周 1 和周 2）
      expect(result).toHaveLength(2);
      // 第一组（周 1）：last = 0.12
      expect(result[0].xirrValue).toBeCloseTo(0.12, 6);
      expect(result[0].label).toBe('2024-W01');
      // 第二组（周 2）：last = 0.13
      expect(result[1].xirrValue).toBeCloseTo(0.13, 6);
      expect(result[1].label).toBe('2024-W02');
    });

    // ----------------------------------------------------------
    // 测试 2b: week 维度 — avg 聚合
    // ----------------------------------------------------------
    it('should compute weekly average for week granularity (avg aggregation)', async () => {
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-03', 0.11),
        makeXirrRecord('2024-01-05', 0.12),
        makeXirrRecord('2024-01-08', 0.13),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.WEEK,
        aggregation: AggregationMethod.AVG,
      });

      expect(result).toHaveLength(2);
      // 第一组：avg = (0.10 + 0.11 + 0.12) / 3 = 0.11
      expect(result[0].xirrValue).toBeCloseTo(0.11, 6);
      // 第二组：avg = 0.13
      expect(result[1].xirrValue).toBeCloseTo(0.13, 6);
    });

    // ----------------------------------------------------------
    // 测试 3: month 维度 — 按年-月分组
    // ----------------------------------------------------------
    it('should group by year-month for month granularity (last aggregation)', async () => {
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-15', 0.11),
        makeXirrRecord('2024-01-31', 0.12),
        makeXirrRecord('2024-02-01', 0.13),
        makeXirrRecord('2024-02-28', 0.14),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.LAST,
      });

      expect(result).toHaveLength(2);
      // 1 月：last = 0.12
      expect(result[0].xirrValue).toBeCloseTo(0.12, 6);
      expect(result[0].label).toBe('2024-01');
      // 2 月：last = 0.14
      expect(result[1].xirrValue).toBeCloseTo(0.14, 6);
      expect(result[1].label).toBe('2024-02');
    });

    // ----------------------------------------------------------
    // 测试 3b: month 维度 — avg 聚合
    // ----------------------------------------------------------
    it('should compute monthly average for month granularity (avg aggregation)', async () => {
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-15', 0.11),
        makeXirrRecord('2024-01-31', 0.12),
        makeXirrRecord('2024-02-01', 0.13),
        makeXirrRecord('2024-02-28', 0.14),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.AVG,
      });

      expect(result).toHaveLength(2);
      // 1 月：avg = (0.10 + 0.11 + 0.12) / 3 = 0.11
      expect(result[0].xirrValue).toBeCloseTo(0.11, 6);
      // 2 月：avg = (0.13 + 0.14) / 2 = 0.135
      expect(result[1].xirrValue).toBeCloseTo(0.135, 6);
    });

    // ----------------------------------------------------------
    // 测试 4: year 维度 — 按年分组
    // ----------------------------------------------------------
    it('should group by year for year granularity (last aggregation)', async () => {
      const records = [
        makeXirrRecord('2023-06-01', 0.08),
        makeXirrRecord('2023-12-31', 0.10),
        makeXirrRecord('2024-01-15', 0.11),
        makeXirrRecord('2024-12-31', 0.15),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.YEAR,
        aggregation: AggregationMethod.LAST,
      });

      expect(result).toHaveLength(2);
      // 2023 年：last = 0.10
      expect(result[0].xirrValue).toBeCloseTo(0.10, 6);
      expect(result[0].label).toBe('2023');
      // 2024 年：last = 0.15
      expect(result[1].xirrValue).toBeCloseTo(0.15, 6);
      expect(result[1].label).toBe('2024');
    });

    // ----------------------------------------------------------
    // 测试 4b: year 维度 — avg 聚合
    // ----------------------------------------------------------
    it('should compute yearly average for year granularity (avg aggregation)', async () => {
      const records = [
        makeXirrRecord('2023-06-01', 0.08),
        makeXirrRecord('2023-12-31', 0.10),
        makeXirrRecord('2024-01-15', 0.11),
        makeXirrRecord('2024-12-31', 0.15),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.YEAR,
        aggregation: AggregationMethod.AVG,
      });

      expect(result).toHaveLength(2);
      // 2023 年：avg = (0.08 + 0.10) / 2 = 0.09
      expect(result[0].xirrValue).toBeCloseTo(0.09, 6);
      // 2024 年：avg = (0.11 + 0.15) / 2 = 0.13
      expect(result[1].xirrValue).toBeCloseTo(0.13, 6);
    });

    // ----------------------------------------------------------
    // 测试 5: last vs avg 直接对比
    // ----------------------------------------------------------
    it('should return different values for last vs avg aggregation', async () => {
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-02', 0.20),
        makeXirrRecord('2024-01-03', 0.30),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      const lastResult = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.LAST,
      });
      const avgResult = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.AVG,
      });

      // last = 0.30 (最后一条)
      expect(lastResult[0].xirrValue).toBeCloseTo(0.30, 6);
      // avg = (0.10 + 0.20 + 0.30) / 3 = 0.20
      expect(avgResult[0].xirrValue).toBeCloseTo(0.20, 6);
      // 两者不同
      expect(lastResult[0].xirrValue).not.toBeCloseTo(avgResult[0].xirrValue!, 6);
    });

    // ----------------------------------------------------------
    // 测试 6: 空数据返回空数组
    // ----------------------------------------------------------
    it('should return empty array when no records found', async () => {
      mockPrisma.dailyXirr.findMany.mockResolvedValue([]);

      const result = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
      });

      expect(result).toEqual([]);
    });

    // ----------------------------------------------------------
    // 测试 7: null xirrValue 处理
    // ----------------------------------------------------------
    it('should handle null xirrValue in aggregation', async () => {
      const records = [
        makeXirrRecord('2024-01-01', 0.10),
        makeXirrRecord('2024-01-15', null), // 数据不足
        makeXirrRecord('2024-01-31', 0.12),
      ];
      mockPrisma.dailyXirr.findMany.mockResolvedValue(records);

      // last 聚合：最后一条是 0.12
      const lastResult = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.LAST,
      });
      expect(lastResult[0].xirrValue).toBeCloseTo(0.12, 6);

      // avg 聚合：只算非 null 的 → (0.10 + 0.12) / 2 = 0.11
      const avgResult = await service.queryXirrSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.AVG,
      });
      expect(avgResult[0].xirrValue).toBeCloseTo(0.11, 6);
    });

    // ----------------------------------------------------------
    // 测试 8: ownership 校验失败抛 NotFoundException
    // ----------------------------------------------------------
    it('should throw when portfolio does not belong to user', async () => {
      mockPrisma.portfolio.findFirst.mockResolvedValue(null);

      await expect(
        service.queryXirrSeries(USER_ID, 'wrong-portfolio', {}),
      ).rejects.toThrow('组合不存在或无权访问');
    });
  });

  // ============================================================
  // NAV 查询
  // ============================================================
  describe('queryNavSeries', () => {
    // ----------------------------------------------------------
    // 测试: month 维度 NAV 聚合
    // ----------------------------------------------------------
    it('should aggregate NAV series by month (last)', async () => {
      const records = [
        makeNavRecord('2024-01-01', 1.0, 1.0, 10000),
        makeNavRecord('2024-01-15', 1.1, 1.1, 10000),
        makeNavRecord('2024-01-31', 1.2, 1.2, 10000),
        makeNavRecord('2024-02-15', 1.3, 1.0833, 10000),
      ];
      mockPrisma.dailyNav.findMany.mockResolvedValue(records);

      const result = await service.queryNavSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.MONTH,
        aggregation: AggregationMethod.LAST,
      });

      expect(result).toHaveLength(2);
      // 1 月：last
      expect(result[0].cumulativeNav).toBeCloseTo(1.2, 6);
      expect(result[0].yearNav).toBeCloseTo(1.2, 6);
      expect(result[0].shares).toBeCloseTo(10000, 4);
      expect(result[0].label).toBe('2024-01');
      // 2 月：last
      expect(result[1].cumulativeNav).toBeCloseTo(1.3, 6);
      expect(result[1].label).toBe('2024-02');
    });

    // ----------------------------------------------------------
    // 测试: day 维度 NAV
    // ----------------------------------------------------------
    it('should return daily NAV data for day granularity', async () => {
      const records = [
        makeNavRecord('2024-01-01', 1.0, 1.0, 10000),
        makeNavRecord('2024-01-02', 1.05, 1.05, 10000),
      ];
      mockPrisma.dailyNav.findMany.mockResolvedValue(records);

      const result = await service.queryNavSeries(USER_ID, PORTFOLIO_ID, {
        granularity: QueryGranularity.DAY,
      });

      expect(result).toHaveLength(2);
      expect(result[0].cumulativeNav).toBeCloseTo(1.0, 6);
      expect(result[1].cumulativeNav).toBeCloseTo(1.05, 6);
    });
  });

  // ============================================================
  // Latest 查询
  // ============================================================
  describe('getLatestXirr', () => {
    it('should return latest XIRR value', async () => {
      mockPrisma.dailyXirr.findFirst.mockResolvedValue({
        date: d('2024-12-31'),
        xirrValue: 0.1234,
      });

      const result = await service.getLatestXirr(USER_ID, PORTFOLIO_ID);
      expect(result.date).toBe('2024-12-31');
      expect(result.xirrValue).toBeCloseTo(0.1234, 6);
    });

    it('should return null when no XIRR records exist', async () => {
      mockPrisma.dailyXirr.findFirst.mockResolvedValue(null);

      const result = await service.getLatestXirr(USER_ID, PORTFOLIO_ID);
      expect(result.date).toBe('');
      expect(result.xirrValue).toBeNull();
    });
  });

  describe('getLatestNav', () => {
    it('should return latest NAV values', async () => {
      mockPrisma.dailyNav.findFirst.mockResolvedValue({
        date: d('2024-12-31'),
        cumulativeNav: 1.456,
        yearNav: 1.082,
        shares: 15000,
      });

      const result = await service.getLatestNav(USER_ID, PORTFOLIO_ID);
      expect(result.date).toBe('2024-12-31');
      expect(result.cumulativeNav).toBeCloseTo(1.456, 6);
      expect(result.yearNav).toBeCloseTo(1.082, 6);
      expect(result.shares).toBeCloseTo(15000, 4);
    });
  });
});
