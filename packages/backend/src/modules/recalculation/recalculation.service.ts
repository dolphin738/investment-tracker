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

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AssetValuationService } from '../valuation/asset-valuation.service';
import { todayInAppTz } from '../../common/utils/app-date.util';
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
   * @returns meta 信息（含重算天数 + 被跳过的手工记录天数）
   */
  async recalculateRange(
    portfolioId: string,
    start: Date,
    end?: Date,
  ): Promise<{
    recalculatedDays: number;
    fromDate: string;
    toDate: string;
    skippedManualDays: number;
  }> {
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

    // F4：被跳过的手工记录天数 = 重算区间内 source='MANUAL' 的快照记录数
    // （AssetSnapshot 有 @@unique([portfolioId, date])，每日至多一条，记录数即天数）
    const skippedManualDays = await this.prisma.assetSnapshot.count({
      where: {
        portfolioId,
        date: { gte: start, lte: until },
        source: 'MANUAL',
      },
    });

    this.logger.log(
      `区间重建完成 portfolioId=${portfolioId} recalculatedDays=${days} skippedManualDays=${skippedManualDays}`,
    );

    return {
      recalculatedDays: days,
      fromDate: fromStr,
      toDate: toStr,
      skippedManualDays,
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
    // 单日失败仍继续尝试后续日期（让尽可能多的日期被计算），
    // 但最终若有失败必须抛出，不许向调用方谎报成功（禁止静默吞异常）
    const failures: { date: string; message: string }[] = [];
    for (const { date } of snapshotDates) {
      try {
        await this.calculationService.triggerCalculation(portfolioId, date);
      } catch (error) {
        const dateStr = date.toISOString().split('T')[0];
        const message = (error as Error).message;
        this.logger.error(
          `计算失败 portfolioId=${portfolioId} date=${dateStr}: ${message}`,
        );
        failures.push({ date: dateStr, message });
      }
    }

    if (failures.length > 0) {
      const dateList = failures.map((f) => f.date).join(', ');
      throw new Error(
        `计算级联存在 ${failures.length}/${snapshotDates.length} 天失败：[${dateList}]。首个错误：${failures[0].message}`,
      );
    }

    return snapshotDates.length;
  }

  // =========================================================
  // 全量重算
  // =========================================================

  /**
   * 全量重算：从组合成立日（第一笔买入日）重建 DERIVED 快照 + 级联计算
   *
   * 使用场景：计算口径变更（如 D-06 资产快照口径调整）后历史净值/XIRR 全部失效，
   * 需要一次性重建。
   *
   * 复用 recalculateRange 的三步流程（DELETE DERIVED -> 逐事件日 persistDerived -> NAV/XIRR 级联），
   * 不另写一套遍历逻辑。end 缺省为 today，即重算到今天。
   *
   * @param portfolioId 组合 ID
   * @returns 重算起始日期（成立日）与受影响天数
   * @throws BadRequestException 组合尚无买入交易（成立日无法确定）
   */
  async recalculateAll(
    portfolioId: string,
  ): Promise<{ fromDate: Date; affectedDays: number }> {
    // 成立日 = 第一笔买入日（与 CalculationService.ensureBaseDate 口径一致）
    const firstBuy = await this.prisma.cashFlow.findFirst({
      where: { portfolioId, type: 'BUY' },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    if (!firstBuy) {
      throw new BadRequestException('组合尚无买入交易，成立日未确定，无法执行全量重算');
    }

    const fromDate = firstBuy.date;
    this.logger.log(
      `开始全量重算 portfolioId=${portfolioId} fromDate=${fromDate.toISOString().split('T')[0]}`,
    );

    const result = await this.recalculateRange(portfolioId, fromDate);

    this.logger.log(
      `全量重算完成 portfolioId=${portfolioId} affectedDays=${result.recalculatedDays}`,
    );

    return { fromDate, affectedDays: result.recalculatedDays };
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
