/**
 * 四维度查询聚合服务
 *
 * 支持按 日/周/月/年 聚合 XIRR 和净值时间序列。
 *
 * 聚合规则：
 * - day：返回每日原始数据（不聚合）
 * - week：按 ISO 周分组（周一为周首日），取周末值或周均
 * - month：按年-月分组，取月末值或月均
 * - year：按年分组，取年末值或年均
 *
 * 聚合方式：
 * - last：取该时间段内最后一条记录的值（与基金披露口径一致）
 * - avg：取该时间段内所有非 null 值的算术平均
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AggregationMethod,
  NavSeriesPoint,
  QueryGranularity,
  XirrSeriesPoint,
} from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';

/** 分组后的数据组 */
interface Group<T> {
  /** 分组键（用于去重） */
  key: string;
  /** 显示标签（如 "2025-03" 或 "2025-W12"） */
  label: string;
  /** 组内记录（已按日期升序排列） */
  items: T[];
}

/** 日期格式化为 YYYY-MM-DD（使用 UTC 避免时区偏移） */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * 计算 ISO 8601 周号
 * 返回 { year, week }，其中 year 是 ISO 周所属的年份（可能与日期所在年份不同）
 */
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNum };
}

/**
 * 根据粒度生成分组键和标签
 */
function getGroupKey(date: Date, granularity: QueryGranularity): { key: string; label: string } {
  const dateStr = formatDate(date);

  switch (granularity) {
    case QueryGranularity.WEEK: {
      const { year, week } = getISOWeek(date);
      return {
        key: `${year}-W${String(week).padStart(2, '0')}`,
        label: `${year}-W${String(week).padStart(2, '0')}`,
      };
    }
    case QueryGranularity.MONTH: {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      return { key: `${y}-${m}`, label: `${y}-${m}` };
    }
    case QueryGranularity.YEAR: {
      const y = date.getUTCFullYear();
      return { key: String(y), label: String(y) };
    }
    default:
      return { key: dateStr, label: dateStr };
  }
}

/**
 * 将记录列表按粒度分组（保持原始顺序）
 */
function groupByGranularity<T extends { date: Date }>(
  records: T[],
  granularity: QueryGranularity,
): Group<T>[] {
  if (granularity === QueryGranularity.DAY) {
    // day 粒度不聚合，每条记录自成一组
    return records.map((r) => {
      const { key, label } = getGroupKey(r.date, granularity);
      return { key, label, items: [r] };
    });
  }

  const groupMap = new Map<string, Group<T>>();
  for (const record of records) {
    const { key, label } = getGroupKey(record.date, granularity);
    const existing = groupMap.get(key);
    if (existing) {
      existing.items.push(record);
    } else {
      groupMap.set(key, { key, label, items: [record] });
    }
  }

  // 按 key 排序（字符串排序对 YYYY-MM 和 YYYY 的时间顺序正确）
  return Array.from(groupMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 聚合数值：last 取最后一条记录的值，avg 取所有非 null 值的平均
 */
function aggregateValues(
  values: (number | null)[],
  method: AggregationMethod,
): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) {
    return null;
  }

  if (method === AggregationMethod.AVG) {
    return nonNull.reduce((sum, v) => sum + v, 0) / nonNull.length;
  }

  // last：取最后一个值（原始数组的最后一个，包括 null）
  return values[values.length - 1] ?? null;
}

@Injectable()
export class QueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 校验组合归属当前用户
   */
  private async verifyOwnership(userId: string, portfolioId: string): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  /**
   * 构建 Prisma where 条件（日期范围）
   */
  private buildDateRange(portfolioId: string, startDate?: string, endDate?: string) {
    return {
      portfolioId,
      ...(startDate || endDate
        ? {
            date: {
              ...(startDate ? { gte: new Date(startDate) } : {}),
              ...(endDate ? { lte: new Date(endDate) } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * 查询 XIRR 时间序列（四维度聚合）
   */
  async queryXirrSeries(
    userId: string,
    portfolioId: string,
    query: {
      granularity?: QueryGranularity;
      aggregation?: AggregationMethod;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<XirrSeriesPoint[]> {
    await this.verifyOwnership(userId, portfolioId);

    const granularity = query.granularity || QueryGranularity.DAY;
    const aggregation = query.aggregation || AggregationMethod.LAST;

    const records = await this.prisma.dailyXirr.findMany({
      where: this.buildDateRange(portfolioId, query.startDate, query.endDate),
      orderBy: { date: 'asc' },
    });

    const groups = groupByGranularity(records, granularity);

    return groups.map((group) => {
      const values = group.items.map((r) =>
        r.xirrValue !== null ? Number(r.xirrValue) : null,
      );
      const lastRecord = group.items[group.items.length - 1];

      return {
        date: formatDate(lastRecord.date),
        xirrValue: aggregateValues(values, aggregation),
        label: group.label,
      };
    });
  }

  /**
   * 查询净值时间序列（四维度聚合）
   */
  async queryNavSeries(
    userId: string,
    portfolioId: string,
    query: {
      granularity?: QueryGranularity;
      aggregation?: AggregationMethod;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<NavSeriesPoint[]> {
    await this.verifyOwnership(userId, portfolioId);

    const granularity = query.granularity || QueryGranularity.DAY;
    const aggregation = query.aggregation || AggregationMethod.LAST;

    const records = await this.prisma.dailyNav.findMany({
      where: this.buildDateRange(portfolioId, query.startDate, query.endDate),
      orderBy: { date: 'asc' },
    });

    const groups = groupByGranularity(records, granularity);

    return groups.map((group) => {
      const cumValues = group.items.map((r) =>
        r.cumulativeNav !== null ? Number(r.cumulativeNav) : null,
      );
      const yearValues = group.items.map((r) =>
        r.yearNav !== null ? Number(r.yearNav) : null,
      );
      const shareValues = group.items.map((r) =>
        r.shares !== null ? Number(r.shares) : null,
      );
      const lastRecord = group.items[group.items.length - 1];

      return {
        date: formatDate(lastRecord.date),
        cumulativeNav: aggregateValues(cumValues, aggregation),
        yearNav: aggregateValues(yearValues, aggregation),
        shares: aggregateValues(shareValues, aggregation),
        label: group.label,
      };
    });
  }

  /**
   * 获取最新 XIRR
   */
  async getLatestXirr(
    userId: string,
    portfolioId: string,
  ): Promise<{ date: string; xirrValue: number | null }> {
    await this.verifyOwnership(userId, portfolioId);

    const latest = await this.prisma.dailyXirr.findFirst({
      where: { portfolioId },
      orderBy: { date: 'desc' },
    });

    if (!latest) {
      return { date: '', xirrValue: null };
    }

    return {
      date: formatDate(latest.date),
      xirrValue: latest.xirrValue !== null ? Number(latest.xirrValue) : null,
    };
  }

  /**
   * 获取最新净值
   */
  async getLatestNav(
    userId: string,
    portfolioId: string,
  ): Promise<{ date: string; cumulativeNav: number | null; yearNav: number | null; shares: number | null }> {
    await this.verifyOwnership(userId, portfolioId);

    const latest = await this.prisma.dailyNav.findFirst({
      where: { portfolioId },
      orderBy: { date: 'desc' },
    });

    if (!latest) {
      return { date: '', cumulativeNav: null, yearNav: null, shares: null };
    }

    return {
      date: formatDate(latest.date),
      cumulativeNav: Number(latest.cumulativeNav),
      yearNav: Number(latest.yearNav),
      shares: Number(latest.shares),
    };
  }
}
