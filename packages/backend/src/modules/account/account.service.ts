/**
 * 账户统计服务
 *
 * 职责：
 * - getStats：返回用户账户统计信息（组合数量、交易笔数、快照天数、数据起止日期、使用天数）
 *
 * 安全：通过 userId 隔离数据，所有查询过滤用户归属。
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 账户统计响应 */
export interface AccountStatsResponse {
  /** 用户拥有的组合数量 */
  portfolioCount: number;
  /**
   * 出入金笔数（CashFlow 计数）
   *
   * 契约变更（Gap B）：原名 `transactionCount`，但其实现只统计 CashFlow（出入金），
   * 完全不含证券买卖，字段名严重误导。**直接改名、不保留兼容别名**。
   */
  cashflowCount: number;
  /** 证券买卖笔数（SecurityTrade 计数，方案B：SecurityTrade 为持仓唯一来源） */
  tradeCount: number;
  /** 有快照数据的天数（跨组合去重） */
  snapshotDays: number;
  /** 最早数据日期（YYYY-MM-DD），null 表示无数据 */
  firstDate: string | null;
  /** 最晚数据日期（YYYY-MM-DD），null 表示无数据 */
  lastDate: string | null;
  /** 数据的记录天数 */
  recordDays: number;
}

/** 日期格式化为 YYYY-MM-DD */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取当前用户的账户统计信息
   */
  async getStats(userId: string): Promise<AccountStatsResponse> {
    // 并行查询所有统计数据
    const [
      portfolioCount,
      totalCashflowCount,
      totalTradeCount,
      snapshotDateRange,
      user,
    ] = await Promise.all([
      // 组合数量
      this.prisma.portfolio.count({ where: { userId } }),

      // 所有组合累计出入金笔数（方案B：CashFlow 为现金流唯一来源）
      this.prisma.cashFlow.count({
        where: { portfolio: { userId } },
      }),

      // 所有组合累计证券买卖笔数（方案B：SecurityTrade 为持仓唯一来源）
      this.prisma.securityTrade.count({
        where: { portfolio: { userId } },
      }),

      // 快照日期范围（跨组合取最早和最晚）
      this.prisma.assetSnapshot.aggregate({
        where: { portfolio: { userId } },
        _min: { date: true },
        _max: { date: true },
      }),

      // 用户注册时间
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { createdAt: true },
      }),
    ]);

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 处理快照日期
    const earliestDate = snapshotDateRange._min?.date ?? null;
    const latestDate = snapshotDateRange._max?.date ?? null;

    // 计算快照天数（去重日期）
    let snapshotDays = 0;
    if (earliestDate && latestDate) {
      // 对无快照数据的用户，快照天数为 0
      const snapshots = await this.prisma.assetSnapshot.findMany({
        where: { portfolio: { userId } },
        select: { date: true },
        distinct: ['date'],
      });
      snapshotDays = snapshots.length;
    }

    // 计算账户使用天数
    const now = new Date();
    const accountAgeMs = now.getTime() - user.createdAt.getTime();
    const accountAgeDays = Math.floor(accountAgeMs / (1000 * 60 * 60 * 24));

    return {
      portfolioCount,
      cashflowCount: totalCashflowCount,
      tradeCount: totalTradeCount,
      snapshotDays,
      firstDate: earliestDate ? formatDate(earliestDate) : null,
      lastDate: latestDate ? formatDate(latestDate) : null,
      recordDays: accountAgeDays,
    };
  }
}
