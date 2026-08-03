/**
 * 总资产派生服务（方案B 核心）
 *
 * 职责：
 * - computeDerived：纯计算当日总资产（不落库），是「系统本应算出多少」的唯一来源
 * - persistDerived：落库 DERIVED 记录（遇 MANUAL 跳过）
 * - upsertManual：手工覆盖当日行，source=MANUAL
 * - deleteRecord：删除记录（若事件日则回填 DERIVED）
 * - resetToDerived：computeDerived → upsert 覆盖，source 置回 DERIVED
 *
 * 【每日唯一】UNIQUE(portfolioId, date) 不含 source
 * 【手工三路径】必须同事务调 recalculateNavRange
 *
 * 详见 PRD §5.4 + ARCH §8
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotSource, SnapshotValuation } from '@investment-tracker/shared';
import { HoldingDerivationService } from '../holding/holding-derivation.service';

/** computeDerived 返回值 */
export interface DerivedResult {
  /** 当日总资产 */
  totalAsset: number;
  /** 持仓市值合计 */
  marketValue: number;
  /** 当日现金余额 */
  cashBalance: number;
  /** 估值标识 */
  valuationFlag: SnapshotValuation;
}

/** upsertManual 入参 */
export interface ManualPayload {
  totalAsset: number;
  marketValue?: number | null;
  cashBalance?: number | null;
  note?: string | null;
}

@Injectable()
export class AssetValuationService {
  private readonly logger = new Logger(AssetValuationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly holdingDerivation: HoldingDerivationService,
  ) {}

  /**
   * 纯计算当日总资产（不落库）
   *
   * totalAsset(D) = marketValue(D) + cashBalance(D)
   * - marketValue：HoldingDerivationService.derive → Σ(qty * price)
   * - cashBalance：CashBalance 中 asOf ≤ date 的最后一条，无则 0
   *
   * valuationFlag 判定：
   * - 所有持仓都有 EXACT 价 → EXACT
   * - 有持仓回退成本估值 → COST_BASED
   * - 无任何持仓（空组合）→ EXACT
   */
  async computeDerived(
    portfolioId: string,
    date: Date,
  ): Promise<DerivedResult> {
    // 1. 持仓市值
    const holdings = await this.holdingDerivation.derive(portfolioId, date);
    const marketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);

    // 2. 现金余额（asOf ≤ date 的最后一条，向前沿用）
    const cashRow = await this.prisma.cashBalance.findFirst({
      where: { portfolioId, asOf: { lte: date } },
      orderBy: { asOf: 'desc' },
      select: { amount: true },
    });
    const cashBalance = cashRow ? Number(cashRow.amount) : 0;

    // 3. 估值标识
    let valuationFlag: SnapshotValuation;
    if (holdings.length === 0) {
      valuationFlag = SnapshotValuation.EXACT;
    } else if (holdings.every((h) => h.flag === 'EXACT')) {
      valuationFlag = SnapshotValuation.EXACT;
    } else if (holdings.every((h) => h.flag === 'COST_BASED')) {
      valuationFlag = SnapshotValuation.COST_BASED;
    } else {
      // 混合：部分有现价部分回退成本
      valuationFlag = SnapshotValuation.CARRIED_FORWARD;
    }

    const totalAsset = marketValue + cashBalance;

    return {
      totalAsset: Math.round(totalAsset * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      cashBalance: Math.round(cashBalance * 100) / 100,
      valuationFlag,
    };
  }

  /**
   * 落库 DERIVED 记录
   *
   * 若当日已有 MANUAL 记录 → 跳过（不写、不覆盖）
   * 否则 upsert（INSERT ... ON CONFLICT DO UPDATE）
   *
   * 🔴 本方法不触发计算层级联（由 recalculateRange 统一编排）
   */
  async persistDerived(portfolioId: string, date: Date): Promise<void> {
    // 先检查是否已有 MANUAL 记录
    const existing = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
      select: { source: true },
    });

    if (existing && existing.source === SnapshotSource.MANUAL) {
      this.logger.debug(
        `persistDerived 跳过：当日已有 MANUAL 记录 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}`,
      );
      return;
    }

    const derived = await this.computeDerived(portfolioId, date);

    await this.prisma.assetSnapshot.upsert({
      where: { portfolioId_date: { portfolioId, date } },
      create: {
        portfolioId,
        date,
        totalAsset: derived.totalAsset,
        marketValue: derived.marketValue,
        cashBalance: derived.cashBalance,
        source: SnapshotSource.DERIVED,
        valuationFlag: derived.valuationFlag,
        note: null,
        recordedAt: new Date(),
      },
      update: {
        totalAsset: derived.totalAsset,
        marketValue: derived.marketValue,
        cashBalance: derived.cashBalance,
        source: SnapshotSource.DERIVED,
        valuationFlag: derived.valuationFlag,
        note: null,
        recordedAt: new Date(),
      },
    });
  }

  /**
   * 手工覆盖当日行
   *
   * 无条件 upsert，source=MANUAL、valuationFlag=MANUAL_INPUT
   *
   * 🔴 调用方必须在本方法返回后调用 recalculateNavRange(portfolioId, date)
   *    由上层在同事务内编排
   */
  async upsertManual(
    portfolioId: string,
    date: Date,
    payload: ManualPayload,
  ): Promise<Date> {
    await this.prisma.assetSnapshot.upsert({
      where: { portfolioId_date: { portfolioId, date } },
      create: {
        portfolioId,
        date,
        totalAsset: payload.totalAsset,
        marketValue: payload.marketValue ?? null,
        cashBalance: payload.cashBalance ?? null,
        source: SnapshotSource.MANUAL,
        valuationFlag: SnapshotValuation.MANUAL_INPUT,
        note: payload.note ?? null,
        recordedAt: new Date(),
      },
      update: {
        totalAsset: payload.totalAsset,
        marketValue: payload.marketValue ?? null,
        cashBalance: payload.cashBalance ?? null,
        source: SnapshotSource.MANUAL,
        valuationFlag: SnapshotValuation.MANUAL_INPUT,
        note: payload.note ?? null,
        recordedAt: new Date(),
      },
    });

    this.logger.log(
      `手工覆盖总资产 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]} totalAsset=${payload.totalAsset}`,
    );

    return date;
  }

  /**
   * 删除当日记录
   *
   * 物理删除后：
   * - 若 date 属于事件日 → 立即 persistDerived 回填 DERIVED
   * - 否则留空，读取时前值填充
   *
   * @returns 删除后的日期（用于级联重算起点）
   *
   * 🔴 调用方必须在本方法返回后调用 recalculateNavRange(portfolioId, date)
   */
  async deleteRecord(portfolioId: string, date: Date): Promise<Date> {
    await this.prisma.assetSnapshot.deleteMany({
      where: { portfolioId, date },
    });

    this.logger.log(
      `删除总资产记录 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}`,
    );

    // 检查是否属于事件日
    const isEventDay = await this.isEventDate(portfolioId, date);

    if (isEventDay) {
      // 立即回填 DERIVED
      await this.persistDerived(portfolioId, date);
      this.logger.debug(
        `删除后回填 DERIVED portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}`,
      );
    }

    return date;
  }

  /**
   * 「重置为自动值」
   *
   * computeDerived(date) → upsert 原地覆盖该行
   * source 置回 DERIVED、valuationFlag 置回计算结果
   *
   * 🔴 不是 DELETE + persistDerived（PRD SNAP-P0-07）
   *
   * 🔴 调用方必须在本方法返回后调用 recalculateNavRange(portfolioId, date)
   */
  async resetToDerived(portfolioId: string, date: Date): Promise<Date> {
    const derived = await this.computeDerived(portfolioId, date);

    await this.prisma.assetSnapshot.upsert({
      where: { portfolioId_date: { portfolioId, date } },
      create: {
        portfolioId,
        date,
        totalAsset: derived.totalAsset,
        marketValue: derived.marketValue,
        cashBalance: derived.cashBalance,
        source: SnapshotSource.DERIVED,
        valuationFlag: derived.valuationFlag,
        note: null,
        recordedAt: new Date(),
      },
      update: {
        totalAsset: derived.totalAsset,
        marketValue: derived.marketValue,
        cashBalance: derived.cashBalance,
        source: SnapshotSource.DERIVED,
        valuationFlag: derived.valuationFlag,
        note: null,
        recordedAt: new Date(),
      },
    });

    this.logger.log(
      `重置为自动值 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]} totalAsset=${derived.totalAsset}`,
    );

    return date;
  }

  /**
   * 判断某日是否属于事件日集合
   * 事件日 = 出入金日期 ∪ 证券买卖日期 ∪ 价格更新日期 ∪ 现金余额变更日期 ∪ 今日
   */
  private async isEventDate(
    portfolioId: string,
    date: Date,
  ): Promise<boolean> {
    const today = todayInAppTz();
    if (date.toISOString().split('T')[0] === today.toISOString().split('T')[0]) {
      return true;
    }

    const [cf, trade, price, cash] = await Promise.all([
      this.prisma.cashFlow.findFirst({
        where: { portfolioId, date },
        select: { id: true },
      }),
      this.prisma.securityTrade.findFirst({
        where: { portfolioId, date },
        select: { id: true },
      }),
      this.prisma.securityPrice.findFirst({
        where: { portfolioId, asOf: date },
        select: { id: true },
      }),
      this.prisma.cashBalance.findFirst({
        where: { portfolioId, asOf: date },
        select: { id: true },
      }),
    ]);

    return !!(cf || trade || price || cash);
  }
}

/** 获取应用时区当天日期（UTC+8 截断） */
export function todayInAppTz(): Date {
  const now = new Date();
  // 使用本地时区的日期字符串来截断，保持向后兼容已有的 Date 处理
  const s = now.toISOString().split('T')[0];
  return new Date(s + 'T00:00:00.000Z');
}
