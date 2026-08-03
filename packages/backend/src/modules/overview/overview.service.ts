/**
 * 概览数据聚合服务
 *
 * 职责：
 * - getOverview(portfolioId): 聚合概览数据（总资产 / 总盈亏 / 持仓汇总 / 近期交易）
 * - 只读，不写任何数据
 *
 * 组合调用现有 service，不依赖 CalculationModule。
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HoldingDerivationService } from '../holding/holding-derivation.service';

/** 概览响应 */
export interface OverviewResponse {
  /** 当前总资产（最新快照） */
  totalAsset: string;
  /** 最新累计净值 */
  cumulativeNav: string;
  /** 最新当年净值 */
  yearNav: string;
  /** 最新累计 XIRR */
  xirr: string | null;
  /** 净投入本金 = SUM(BUY) - SUM(SELL) */
  netInvested: string;
  /** 累计收益率 = cumulativeNav - 1 */
  totalReturnRate: string;
  /** 当年收益率 = yearNav - 1 */
  yearReturnRate: string;
  /** 数据截止日期 */
  latestDate: string;
  /** 持仓汇总 */
  holdingsSummary: {
    totalMarketValue: string;
    totalCost: string;
    totalProfit: string;
    securityCount: number;
  };
  /** 最近 5 笔交易 */
  recentTransactions: Array<{
    id: string;
    date: string;
    type: string;
    amount: string;
    note: string | null;
  }>;
}

@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holdingDerivationService: HoldingDerivationService,
  ) {}

  /**
   * 验证组合归属权
   */
  private async validatePortfolioOwnership(
    portfolioId: string,
    userId: string,
  ): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  /**
   * 获取组合概览数据（只读聚合）
   */
  async getOverview(
    portfolioId: string,
    userId: string,
  ): Promise<OverviewResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    // 并行查询：最新快照、最新净值、最新 XIRR、净投入现金流（持仓由推导服务按日期计算）
    const [
      latestSnapshot,
      latestNav,
      latestXirr,
      transactions,
    ] = await Promise.all([
      // 最新资产快照
      this.prisma.assetSnapshot.findFirst({
        where: { portfolioId },
        orderBy: { date: 'desc' },
        select: { totalAsset: true, date: true },
      }),
      // 最新净值
      this.prisma.dailyNav.findFirst({
        where: { portfolioId },
        orderBy: { date: 'desc' },
        select: { cumulativeNav: true, yearNav: true, date: true },
      }),
      // 最新 XIRR
      this.prisma.dailyXirr.findFirst({
        where: { portfolioId },
        orderBy: { date: 'desc' },
        select: { xirrValue: true, date: true },
      }),
      // 全部 BUY/SELL 出入金（用于计算净投入）
      this.prisma.cashFlow.findMany({
        where: { portfolioId },
        select: { type: true, amount: true },
      }),
    ]);

    // 计算净投入
    let netInvested = 0;
    for (const txn of transactions) {
      const amt = Number(txn.amount);
      if (txn.type === 'BUY') {
        netInvested += amt;
      } else if (txn.type === 'SELL') {
        netInvested -= amt;
      }
    }

    // 计算累计/当年收益率
    const cumulativeNav = latestNav ? Number(latestNav.cumulativeNav) : 1;
    const yearNav = latestNav ? Number(latestNav.yearNav) : 1;
    const totalReturnRate = cumulativeNav - 1;
    const yearReturnRate = yearNav - 1;
    const latestDate =
      latestSnapshot?.date?.toISOString().split('T')[0] ??
      latestNav?.date?.toISOString().split('T')[0] ??
      '';

    // 持仓汇总（方案B：由 SecurityTrade 派生，取最新数据日期）
    let holdingsSummary = {
      totalMarketValue: '0',
      totalCost: '0',
      totalProfit: '0',
      securityCount: 0,
    };

    const holdings = await this.holdingDerivationService.derive(
      portfolioId,
      latestDate ? new Date(latestDate) : new Date(),
    );

    if (holdings.length > 0) {
      let totalMarketValue = 0;
      let totalCost = 0;
      let count = 0;

      for (const h of holdings) {
        if (h.quantity <= 0) continue;
        totalMarketValue += h.marketValue;
        totalCost += h.costTotal;
        count++;
      }

      holdingsSummary = {
        totalMarketValue: totalMarketValue.toFixed(2),
        totalCost: totalCost.toFixed(2),
        totalProfit: (totalMarketValue - totalCost).toFixed(2),
        securityCount: count,
      };
    }

    // 最近 5 笔出入金
    const recentTransactions = await this.prisma.cashFlow.findMany({
      where: { portfolioId },
      orderBy: { date: 'desc' },
      take: 5,
      select: { id: true, date: true, type: true, amount: true, note: true },
    });

    return {
      totalAsset: latestSnapshot ? latestSnapshot.totalAsset.toString() : '0',
      cumulativeNav: cumulativeNav.toFixed(6),
      yearNav: yearNav.toFixed(6),
      xirr: latestXirr?.xirrValue ? latestXirr.xirrValue.toString() : null,
      netInvested: netInvested.toFixed(2),
      totalReturnRate: totalReturnRate.toFixed(8),
      yearReturnRate: yearReturnRate.toFixed(8),
      latestDate,
      holdingsSummary,
      recentTransactions: recentTransactions.map((t) => ({
        id: t.id,
        date: t.date.toISOString().split('T')[0],
        type: t.type,
        amount: t.amount.toString(),
        note: t.note,
      })),
    };
  }
}
