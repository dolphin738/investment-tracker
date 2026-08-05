/**
 * 概览数据聚合服务
 *
 * 职责：
 * - getOverview(portfolioId): 聚合概览数据（总资产 / 总盈亏 / 持仓汇总 / 近期交易）
 * - 只读，不写任何数据
 *
 * 组合调用现有 service，不依赖 CalculationModule。
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SnapshotSource } from '@investment-tracker/shared';
import { FreshnessKind } from '@investment-tracker/shared';
import type { FreshnessInfo, FreshnessReason } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { HoldingDerivationService } from '../holding/holding-derivation.service';
import { todayInAppTz } from '../../common/utils/app-date.util';

/**
 * 计算 asOf（YYYY-MM-DD）到 today（UTC+8 当天 UTC 午夜）的自然日差。
 *
 * 两者均为 UTC 午夜 Date，相减再整除 86_400_000 即精确整数天数。
 * 调用方已用 `asOf <= today` 过滤，故结果恒 ≥ 0。
 */
function diffDaysInAppTz(today: Date, asOf: string): number {
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  return Math.floor((today.getTime() - asOfDate.getTime()) / 86_400_000);
}

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
  /**
   * 最新总资产快照的来源（Q-2 乙 · 供概览页「✋手工」徽标 / 数据新鲜度提示）
   *
   * - 'MANUAL'：该日总资产为用户手工录入（前端展示「✋手工」徽标）
   * - 'DERIVED'：系统按持仓市值 + 现金余额自动派生
   * - null：该组合尚无任何 AssetSnapshot（此时 latestDate 也为空或取自 DailyNav）
   */
  latestSource: SnapshotSource | null;
  /**
   * 数据新鲜度（PRD DASH-P1-03 / AL-015 · 决策 O-6）
   *
   * 🔴 判定**只在后端做**（阈值比较 / 滞后天数 / 文案），前端只渲染。
   * 口径＝行情 / 现金实际数据的 asOf 滞后，**不是**快照 latestDate。
   * 详见 `packages/shared/src/types/overview.ts` 的 `FreshnessInfo`。
   */
  freshness: FreshnessInfo;
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
  private readonly logger = new Logger(OverviewService.name);

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
        // source 供前端「✋手工」徽标判定（Q-2 乙），避免额外打一次 snapshots 请求
        select: { totalAsset: true, date: true, source: true },
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

    // 数据新鲜度（PRD DASH-P1-03 / AL-015 · 决策 O-6）
    // 口径＝当前持仓标的的行情 / 现金 asOf 滞后，非快照 latestDate。
    // 🔴 新鲜度是**增强信息**：计算失败一律降级为空 freshness（staleDays 取默认 3），
    // 绝不因此影响主响应（主响应字段照常返回）。
    const heldSecurityIds = holdings
      .filter((h) => h.quantity > 0)
      .map((h) => h.securityId);
    let freshness: FreshnessInfo = {
      staleDays: 3,
      isStale: false,
      latestPriceAsOf: null,
      latestPriceLagDays: null,
      latestCashAsOf: null,
      latestCashLagDays: null,
      reasons: [],
    };
    try {
      freshness = await this.buildFreshness(
        portfolioId,
        userId,
        heldSecurityIds,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `新鲜度计算失败，降级为空 freshness：portfolioId=${portfolioId} reason=${message}`,
      );
    }

    return {
      totalAsset: latestSnapshot ? latestSnapshot.totalAsset.toString() : '0',
      cumulativeNav: cumulativeNav.toFixed(6),
      yearNav: yearNav.toFixed(6),
      xirr: latestXirr?.xirrValue ? latestXirr.xirrValue.toString() : null,
      netInvested: netInvested.toFixed(2),
      totalReturnRate: totalReturnRate.toFixed(8),
      yearReturnRate: yearReturnRate.toFixed(8),
      latestDate,
      latestSource: latestSnapshot?.source ?? null,
      freshness,
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

  /**
   * 构建数据新鲜度信息（PRD DASH-P1-03 / AL-015 · 决策 O-6）
   *
   * 判定口径（🔴 全部在后端完成，前端只渲染）：
   * - `staleDays`：取自 `UserPreference.staleDays`，缺省 3。
   * - 行情维度：在当前持仓标的（qty>0）中，取**每只最落后行情**`MIN(MAX(SecurityPrice.asOf))`。
   *   只要有一只持仓标的**无任何行情记录**，即视为最陈旧（asOf=null）。
   * - 现金维度：`MAX(CashBalance.asOf)`。
   * - 滞后天数 = asOf → 今天（`todayInAppTz()`，UTC+8）的自然日差。
   * - `isStale` / `reasons`：任一维度滞后超过 `staleDays`（或持仓标的缺行情）即 stale。
   *
   * @param portfolioId 组合 ID
   * @param userId 用户 ID（读 staleDays）
   * @param heldSecurityIds 当前持仓标的 ID（qty>0）；空数组 → 行情维度直接为 null
   * @returns FreshnessInfo
   */
  private async buildFreshness(
    portfolioId: string,
    userId: string,
    heldSecurityIds: string[],
  ): Promise<FreshnessInfo> {
    const staleDays = await this.getStaleDays(userId);
    const today = todayInAppTz();

    // ── 行情维度 ──
    let latestPriceAsOf: string | null = null;
    let latestPriceLagDays: number | null = null;
    const heldCount = heldSecurityIds.length;

    if (heldCount > 0) {
      const grouped = await this.prisma.securityPrice.groupBy({
        by: ['securityId'],
        where: {
          portfolioId,
          securityId: { in: heldSecurityIds },
          asOf: { lte: today },
        },
        _max: { asOf: true },
      });

      // 每只持仓标的的最迟行情日期；缺失行情的标的不会出现在结果里
      const maxAsOfList = grouped
        .map((g) => g._max.asOf)
        .filter((d): d is Date => d !== null);

      if (maxAsOfList.length < heldCount) {
        // 至少一只持仓标的**完全无行情记录** → 视为最陈旧（asOf=null）
        latestPriceAsOf = null;
        latestPriceLagDays = null;
      } else if (maxAsOfList.length > 0) {
        // 最落后的那只 = MIN(MAX(asOf))（YYYY-MM-DD 字符串序＝时间序）
        const minAsOf = maxAsOfList
          .map((d) => d.toISOString().split('T')[0])
          .reduce((min, s) => (s < min ? s : min));
        latestPriceAsOf = minAsOf;
        latestPriceLagDays = diffDaysInAppTz(today, minAsOf);
      }
    }

    // ── 现金维度 ──
    let latestCashAsOf: string | null = null;
    let latestCashLagDays: number | null = null;
    const cashAgg = await this.prisma.cashBalance.aggregate({
      where: { portfolioId, asOf: { lte: today } },
      _max: { asOf: true },
    });
    if (cashAgg._max.asOf) {
      const asOf = cashAgg._max.asOf.toISOString().split('T')[0];
      latestCashAsOf = asOf;
      latestCashLagDays = diffDaysInAppTz(today, asOf);
    }

    // ── 阈值比较 + 文案 ──
    const priceStale =
      (latestPriceAsOf === null && heldCount > 0) ||
      (latestPriceLagDays !== null && latestPriceLagDays > staleDays);
    const cashStale =
      latestCashAsOf !== null &&
      latestCashLagDays !== null &&
      latestCashLagDays > staleDays;

    const reasons: FreshnessReason[] = [];
    if (priceStale) {
      reasons.push({
        kind: FreshnessKind.PRICE,
        asOf: latestPriceAsOf,
        lagDays: latestPriceLagDays,
        label:
          latestPriceAsOf === null
            ? '部分持仓标的无行情数据，请更新现价'
            : `行情已 ${latestPriceLagDays} 天未更新`,
      });
    }
    if (cashStale) {
      reasons.push({
        kind: FreshnessKind.CASH,
        asOf: latestCashAsOf,
        lagDays: latestCashLagDays,
        label: `现金余额已 ${latestCashLagDays} 天未更新`,
      });
    }

    return {
      staleDays,
      isStale: priceStale || cashStale,
      latestPriceAsOf,
      latestPriceLagDays,
      latestCashAsOf,
      latestCashLagDays,
      reasons,
    };
  }

  /**
   * 读取用户陈旧阈值（天）。
   *
   * 取自 `UserPreference.staleDays`；记录缺失或查询异常一律回落默认 3。
   */
  private async getStaleDays(userId: string): Promise<number> {
    try {
      const pref = await this.prisma.userPreference.findUnique({
        where: { userId },
        select: { staleDays: true },
      });
      return pref?.staleDays ?? 3;
    } catch {
      return 3;
    }
  }
}
