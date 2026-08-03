/**
 * 批量重算编排服务（统一入口）
 *
 * 职责：
 * - recalculateRange：T1~T4 入口 —— 快照层区间重建 + 计算层级联
 * - recalculateNavRange：T5 入口 —— 只做计算层级联，不碰快照层
 *
 * 【五类触发事件】见 ARCH §7.3.1：
 *   T1 出入金 → recalculateRange(P, date)
 *   T2 证券买卖 → recalculateRange(P, date)
 *   T3 标的最新价 → recalculateRange(P, asOf)
 *   T4 现金余额 → recalculateRange(P, asOf)
 *   T5 手工总资产 → recalculateNavRange(P, date)
 *
 * 【区间重建三步】：
 *   ① DELETE asset_snapshots WHERE source='DERIVED' AND date BETWEEN start AND end
 *   ② 逐事件日 persistDerived（ON CONFLICT DO NOTHING 双保险）
 *   ③ recalculateNavRange（按快照日期集合而非事件日集合）
 *
 * 【计算层级联】：
 *   SELECT DISTINCT date FROM asset_snapshots WHERE date >= start → 升序逐日 NAV→XIRR
 *
 * 🔴 end 缺省一律为 today（不是 start）
 * 🔴 C-13: 快照层任何写操作必须同事务触发计算层级联
 *
 * 详见 ARCH §7.3 + PRD §5.4.4
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AssetValuationService, todayInAppTz } from '../valuation/asset-valuation.service';
import { CalculationService } from '../calculation/calculation.service';

@Injectable()
export class RecalculationService {
  private readonly logger = new Logger(RecalculationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assetValuation: AssetValuationService,
    private readonly calculationService: CalculationService,
  ) {}

  // =========================================================
  // T1~T4 入口
  // =========================================================

  /**
   * 快照区间重建 + NAV/XIRR 级联
   *
   * T1~T4 用：出入金 / 证券买卖 / 现价 / 现金余额 变更后调用。
   *
   * 三步流程：
   * ① DELETE asset_snapshots WHERE source='DERIVED' AND date BETWEEN start AND end
   * ② 逐事件日 persistDerived（遇 MANUAL 跳过）
   * ③ recalculateNavRange
   *
   * @param portfolioId 组合 ID
   * @param start 起始日期
   * @param end 结束日期（缺省 = today）
   * @returns meta 信息（含重算天数）
   */
  async recalculateRange(
    portfolioId: string,
    start: Date,
    end?: Date,
  ): Promise<{ recalculatedDays: number; fromDate: string; toDate: string }> {
    const until = end ?? todayInAppTz();

    const fromStr = start.toISOString().split('T')[0];
    const toStr = until.toISOString().split('T')[0];

    this.logger.log(
      `区间重建开始 portfolioId=${portfolioId} range=[${fromStr}, ${toStr}]`,
    );

    // ① DELETE DERIVED 记录（双保险①：不误删 MANUAL）
    // 🔴 事件日集合决定哪些天需要重派生
    const eventDates = await this.getEventDates(portfolioId, start, until);

    if (eventDates.length > 0) {
      await this.prisma.assetSnapshot.deleteMany({
        where: {
          portfolioId,
          date: { in: eventDates },
          source: 'DERIVED',
        },
      });

      this.logger.debug(
        `区间重建 ①：删除 DERIVED 记录 ${eventDates.length} 天`,
      );

      // ② 逐事件日重派生（双保险②：persistDerived 内部遇 MANUAL 跳过）
      for (const d of eventDates) {
        await this.assetValuation.persistDerived(portfolioId, d);
      }

      this.logger.debug(`区间重建 ②：逐事件日 persistDerived 完成`);
    }

    // ③ NAV/XIRR 级联（按快照日期集合，非事件日集合）
    const days = await this.recalculateNavRange(portfolioId, start, until);

    this.logger.log(
      `区间重建完成 portfolioId=${portfolioId} recalculatedDays=${days}`,
    );

    return {
      recalculatedDays: days,
      fromDate: fromStr,
      toDate: toStr,
    };
  }

  // =========================================================
  // T5 入口（也被 recalculateRange ③ 复用）
  // =========================================================

  /**
   * 只做计算层级联，不碰快照层
   *
   * T5 用：手工总资产记录的 新建 / 编辑 / 删除 / 重置。
   * 也被 recalculateRange 的第 ③ 步复用。
   *
   * 快照日期集合（非事件日集合）：
   *   SELECT DISTINCT date FROM asset_snapshots
   *    WHERE portfolioId AND date >= start ORDER BY date ASC
   *
   * 升序逐日：NAV → XIRR（净值前日依赖，不可乱序、不可并行）
   *
   * @param portfolioId 组合 ID
   * @param start 起始日期
   * @param end 结束日期（缺省 = today）
   * @returns 重算天数
   */
  async recalculateNavRange(
    portfolioId: string,
    start: Date,
    end?: Date,
  ): Promise<number> {
    const until = end ?? todayInAppTz();

    // 🔴 快照日期集合：总资产记录表中实际存在的日期
    //    不能用 eventDates —— 手工记录日可能不是事件日，用事件日会漏算
    const snapshotDates = await this.prisma.assetSnapshot.findMany({
      where: {
        portfolioId,
        date: { gte: start, lte: until },
      },
      orderBy: { date: 'asc' },
      select: { date: true },
      distinct: ['date'],
    });

    this.logger.debug(
      `计算层级联：${snapshotDates.length} 天 portfolioId=${portfolioId} range=[${start.toISOString().split('T')[0]}, ${until.toISOString().split('T')[0]}]`,
    );

    // 升序逐日：NAV → XIRR（不可乱序、不可并行）
    for (const { date } of snapshotDates) {
      try {
        await this.calculationService.triggerCalculation(portfolioId, date);
      } catch (error) {
        this.logger.error(
          `计算失败 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}: ${(error as Error).message}`,
        );
        // 🔴 单日失败不阻断后续日期（已记录日志），
        //    但如果上日净值缺失导致下日 share 为 0，下日也会报错。
        //    这里选择继续尝试，让尽可能多的日期被计算。
      }
    }

    return snapshotDates.length;
  }

  // =========================================================
  // 事件日集合
  // =========================================================

  /**
   * 获取区间内所有事件日（升序、去重）
   *
   * 事件日 = 出入金日期 ∪ 证券买卖日期 ∪ 价格更新日期(asOf) ∪ 现金余额变更日期(asOf) ∪ 今日
   */
  private async getEventDates(
    portfolioId: string,
    start: Date,
    end: Date,
  ): Promise<Date[]> {
    const dateSet = new Set<string>();
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    // 出入金
    const cfDates = await this.prisma.cashFlow.findMany({
      where: { portfolioId, date: { gte: start, lte: end } },
      select: { date: true },
      distinct: ['date'],
    });
    for (const r of cfDates) dateSet.add(fmt(r.date));

    // 证券买卖
    const tradeDates = await this.prisma.securityTrade.findMany({
      where: { portfolioId, date: { gte: start, lte: end } },
      select: { date: true },
      distinct: ['date'],
    });
    for (const r of tradeDates) dateSet.add(fmt(r.date));

    // 标的最新价
    const priceDates = await this.prisma.securityPrice.findMany({
      where: { portfolioId, asOf: { gte: start, lte: end } },
      select: { asOf: true },
      distinct: ['asOf'],
    });
    for (const r of priceDates) dateSet.add(fmt(r.asOf));

    // 现金余额
    const cashDates = await this.prisma.cashBalance.findMany({
      where: { portfolioId, asOf: { gte: start, lte: end } },
      select: { asOf: true },
      distinct: ['asOf'],
    });
    for (const r of cashDates) dateSet.add(fmt(r.asOf));

    // 今日
    const today = todayInAppTz();
    if (today >= start && today <= end) {
      dateSet.add(fmt(today));
    }

    // 升序排列
    return Array.from(dateSet)
      .sort()
      .map((s) => new Date(s + 'T00:00:00.000Z'));
  }
}
