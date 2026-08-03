/**
 * 四维度查询聚合服务（增强版）
 *
 * 🆕 T03 增强：
 *   - getPortfolioSummary：组合统计摘要（Dashboard 卡片）
 *   - getMultiPortfolioSummary：多组合对比
 *   - getDrawdown：最大回撤时间序列
 *   - 手动触发重算（委托 RecalculationService）
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../recalculation/recalculation.service';

/** 日期格式化为 YYYY-MM-DD */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// ── 查询增强服务 ──

/** 组合统计摘要 */
export interface PortfolioSummary {
  cumulativeXirr: number | null;
  totalReturnRate: number | null;
  yearReturnRate: number | null;
  maxDrawdown: number | null;
  latestDate: string;
  inceptionDate: string;
}

/** 回撤数据点 */
export interface DrawdownPoint {
  date: string;
  drawdown: number | null;
  peakDate: string | null;
  label: string;
}

@Injectable()
export class QueryServiceEnhanced {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /** 校验组合归属 */
  private async verifyOwnership(
    userId: string,
    portfolioId: string,
  ): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  // =========================================================
  // 组合统计摘要
  // =========================================================

  /**
   * 获取单个组合的统计摘要
   */
  async getPortfolioSummary(
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioSummary> {
    await this.verifyOwnership(userId, portfolioId);

    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
      select: { baseDate: true },
    });

    // 最新 XIRR
    const latestXirr = await this.prisma.dailyXirr.findFirst({
      where: { portfolioId },
      orderBy: { date: 'desc' },
      select: { date: true, xirrValue: true },
    });

    // 最新净值
    const latestNav = await this.prisma.dailyNav.findFirst({
      where: { portfolioId },
      orderBy: { date: 'desc' },
      select: { date: true, cumulativeNav: true, yearNav: true },
    });

    // 最大回撤
    const maxDrawdown = await this.computeMaxDrawdown(portfolioId);

    const cumNav = latestNav ? Number(latestNav.cumulativeNav) : null;
    const yearNav = latestNav ? Number(latestNav.yearNav) : null;

    return {
      cumulativeXirr: latestXirr?.xirrValue
        ? Number(latestXirr.xirrValue)
        : null,
      totalReturnRate: cumNav !== null ? cumNav - 1 : null,
      yearReturnRate: yearNav !== null ? yearNav - 1 : null,
      maxDrawdown,
      latestDate: latestNav
        ? formatDate(latestNav.date)
        : latestXirr
          ? formatDate(latestXirr.date)
          : '',
      inceptionDate: portfolio?.baseDate
        ? formatDate(portfolio.baseDate)
        : '',
    };
  }

  /**
   * 多组合对比摘要
   */
  async getMultiPortfolioSummary(
    userId: string,
  ): Promise<(PortfolioSummary & { portfolioId: string; name: string })[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, name: true, baseDate: true },
      orderBy: { createdAt: 'desc' },
    });

    const results: (PortfolioSummary & {
      portfolioId: string;
      name: string;
    })[] = [];

    for (const p of portfolios) {
      const latestXirr = await this.prisma.dailyXirr.findFirst({
        where: { portfolioId: p.id },
        orderBy: { date: 'desc' },
        select: { xirrValue: true },
      });

      const latestNav = await this.prisma.dailyNav.findFirst({
        where: { portfolioId: p.id },
        orderBy: { date: 'desc' },
        select: { date: true, cumulativeNav: true, yearNav: true },
      });

      const cumNav = latestNav ? Number(latestNav.cumulativeNav) : null;
      const yearNav = latestNav ? Number(latestNav.yearNav) : null;

      results.push({
        portfolioId: p.id,
        name: p.name,
        cumulativeXirr: latestXirr?.xirrValue
          ? Number(latestXirr.xirrValue)
          : null,
        totalReturnRate: cumNav !== null ? cumNav - 1 : null,
        yearReturnRate: yearNav !== null ? yearNav - 1 : null,
        maxDrawdown: null, // 多组合对比不做逐组合回撤（性能）
        latestDate: latestNav ? formatDate(latestNav.date) : '',
        inceptionDate: p.baseDate ? formatDate(p.baseDate) : '',
      });
    }

    return results;
  }

  // =========================================================
  // 手动触发重算
  // =========================================================

  /**
   * 手动触发批量重算
   */
  async triggerRecalculate(
    userId: string,
    portfolioId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<{ recalculatedDays: number; fromDate: string; toDate: string }> {
    await this.verifyOwnership(userId, portfolioId);

    // 若未指定 startDate，从组合成立日起
    let start: Date;
    if (startDate) {
      start = new Date(startDate + 'T00:00:00.000Z');
    } else {
      const portfolio = await this.prisma.portfolio.findUnique({
        where: { id: portfolioId },
        select: { baseDate: true },
      });
      if (!portfolio?.baseDate) {
        return {
          recalculatedDays: 0,
          fromDate: '',
          toDate: '',
        };
      }
      start = portfolio.baseDate;
    }

    const end = endDate ? new Date(endDate + 'T00:00:00.000Z') : undefined;

    return this.recalculationService.recalculateRange(
      portfolioId,
      start,
      end,
    );
  }

  // =========================================================
  // 最大回撤
  // =========================================================

  /**
   * 最大回撤时间序列
   *
   * 基于 daily_nav.cumulativeNav 计算：
   *   drawdown_t = cumulativeNav_t / max(cumulativeNav_{≤t}) - 1
   */
  async getDrawdown(
    userId: string,
    portfolioId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<DrawdownPoint[]> {
    await this.verifyOwnership(userId, portfolioId);

    const where: Record<string, unknown> = { portfolioId };
    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate + 'T00:00:00.000Z') } : {}),
        ...(endDate ? { lte: new Date(endDate + 'T00:00:00.000Z') } : {}),
      };
    }

    const records = await this.prisma.dailyNav.findMany({
      where,
      orderBy: { date: 'asc' },
      select: { date: true, cumulativeNav: true },
    });

    if (records.length === 0) return [];

    let peak = Number(records[0].cumulativeNav);
    let peakDate = records[0].date;

    return records.map((r) => {
      const nav = Number(r.cumulativeNav);
      if (nav > peak) {
        peak = nav;
        peakDate = r.date;
      }
      const drawdown = peak > 0 ? nav / peak - 1 : 0;

      return {
        date: formatDate(r.date),
        drawdown: Math.round(drawdown * 10000) / 10000,
        peakDate: formatDate(peakDate),
        label: formatDate(r.date),
      };
    });
  }

  /**
   * 计算单值最大回撤（用于摘要）
   */
  private async computeMaxDrawdown(
    portfolioId: string,
  ): Promise<number | null> {
    const records = await this.prisma.dailyNav.findMany({
      where: { portfolioId },
      orderBy: { date: 'asc' },
      select: { cumulativeNav: true },
    });

    if (records.length === 0) return null;

    let peak = Number(records[0].cumulativeNav);
    let maxDD = 0;

    for (const r of records) {
      const nav = Number(r.cumulativeNav);
      if (nav > peak) peak = nav;
      const dd = peak > 0 ? (nav - peak) / peak : 0;
      if (dd < maxDD) maxDD = dd;
    }

    return Math.round(maxDD * 10000) / 10000;
  }
}
