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
 * 【区间重建四步】：
 *   ① DELETE asset_snapshots WHERE source='DERIVED' AND date BETWEEN start AND end
 *   ② 逐事件日 persistDerived（ON CONFLICT DO NOTHING 双保险）
 *   ②.5 孤儿 DERIVED 快照清理（问题⑧）：删除「已非事件日 + 派生值恒为 0」的残留行
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
   * 四步流程：
   * ① DELETE asset_snapshots WHERE source='DERIVED' AND date BETWEEN start AND end
   * ② 逐事件日 persistDerived（遇 MANUAL 跳过）
   * ②.5 孤儿 DERIVED 快照清理（问题⑧）
   * ③ recalculateNavRange
   *
   * @param portfolioId 组合 ID
   * @param start 起始日期
   * @param end 结束日期（缺省 = today）
   * @returns meta 信息（含重算天数 + 被跳过的手工记录天数 + 被清理的孤儿快照天数）
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
    /** 被清理的孤儿 DERIVED 快照天数（问题⑧） */
    cleanedOrphanDays: number;
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

    // ②.5 孤儿 DERIVED 快照清理（问题⑧）
    // 🔴 必须在 ③ 之前：NAV 级联按「前日净值」链式推进，若把 totalAsset=0 的孤儿日
    //    留到级联里，0 值会先污染当日净值、再经 prevNav 传染给其后所有日期；
    //    级联后再删只能抹掉孤儿日那一行，污染已经扩散出去了。
    const cleanedOrphanDays = await this.cleanupOrphanDerivedSnapshots(
      portfolioId,
      start,
      until,
      eventDates,
    );

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
      `区间重建完成 portfolioId=${portfolioId} recalculatedDays=${days} skippedManualDays=${skippedManualDays} cleanedOrphanDays=${cleanedOrphanDays}`,
    );

    return {
      recalculatedDays: days,
      fromDate: fromStr,
      toDate: toStr,
      skippedManualDays,
      cleanedOrphanDays,
    };
  }

  // =========================================================
  // 孤儿 DERIVED 快照清理（问题⑧）
  // =========================================================

  /**
   * 清理「孤儿 DERIVED 快照」——删旧 cashflow 后残留的 totalAsset=0 幽灵行。
   *
   * 【问题⑧根因】
   * 设 D 日原本只有一笔 cashflow。删除该 cashflow 后：
   * - `getEventDates` 不再包含 D（D 已无任何事件）；
   * - 步骤 ① 的 `DELETE ... date IN eventDates` 因此**删不到** D 的旧 DERIVED 行；
   * - 但 `recalculateNavRange` 用的是「快照日期集合」（`SELECT DISTINCT date FROM
   *   asset_snapshots WHERE date >= start`），该集合**仍含 D**；
   * - 于是对 D 调 NAV 计算，而 D 已无持仓、无现金 → `computeDerived` 得 totalAsset=0，
   *   留下一条 0 值孤儿 DERIVED 快照，持续参与净值/XIRR 链路。
   *
   * 【清理判据】（三个条件同时满足才删，缺一不可）
   * 1. 该日快照 `source === 'DERIVED'` —— 绝不误删用户的 MANUAL 记录；
   * 2. 该日**不在** eventDates 中 —— 即确实无 trade/price/cash/cashflow/today；
   * 3. `computeDerived(d)` 结果为 0 —— 无持仓（marketValue=0）且无 ≤d 的现金余额
   *    （cashBalance=0）。非 0 的残留行说明该日仍有真实资产，保留。
   *
   * 【删除范围】物理删除 asset_snapshots + daily_nav + daily_xirr 三张表的当日行，
   * 与 {@link AssetValuationService.deleteRecord} 的事务模式一致 —— 只删快照不删
   * nav/xirr 会留下陈旧净值行，被后续重算当成 prevNav 幽灵结转。
   *
   * @param portfolioId 组合 ID
   * @param start 区间起始日
   * @param end 区间结束日
   * @param eventDates 本次重建的事件日集合（步骤 ① 已算好，直接复用避免重复查库）
   * @returns 被清理的天数
   */
  private async cleanupOrphanDerivedSnapshots(
    portfolioId: string,
    start: Date,
    end: Date,
    eventDates: readonly Date[],
  ): Promise<number> {
    const fmt = (d: Date): string => d.toISOString().split('T')[0];
    const eventDateKeys = new Set(eventDates.map(fmt));

    // 候选：区间内「非事件日」的 DERIVED 快照。
    // 正常情况下 DERIVED 快照只会落在事件日，因此候选集通常为空或极小。
    const derivedRows = await this.prisma.assetSnapshot.findMany({
      where: {
        portfolioId,
        date: { gte: start, lte: end },
        source: 'DERIVED',
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    const candidates = derivedRows
      .map((r) => r.date)
      .filter((d) => !eventDateKeys.has(fmt(d)));

    if (candidates.length === 0) {
      return 0;
    }

    // 批量派生（3 次查库，与候选数量无关；避免逐日 computeDerived 的 N+1）
    const derivedByDate = await this.assetValuation.computeDerivedBatch(
      portfolioId,
      candidates,
    );

    const orphans = candidates.filter((d) => {
      const derived = derivedByDate.get(fmt(d));
      // 取不到派生值时保守保留（宁可漏清也不误删）
      if (!derived) return false;
      return (
        derived.totalAsset === 0 &&
        derived.marketValue === 0 &&
        derived.cashBalance === 0
      );
    });

    if (orphans.length === 0) {
      return 0;
    }

    // 同事务删除快照 + 净值 + XIRR，避免陈旧 nav 行被当作 prevNav 幽灵结转
    await this.prisma.$transaction([
      this.prisma.assetSnapshot.deleteMany({
        where: { portfolioId, date: { in: orphans }, source: 'DERIVED' },
      }),
      this.prisma.dailyNav.deleteMany({
        where: { portfolioId, date: { in: orphans } },
      }),
      this.prisma.dailyXirr.deleteMany({
        where: { portfolioId, date: { in: orphans } },
      }),
    ]);

    this.logger.log(
      `区间重建 ②.5：清理孤儿 DERIVED 快照 ${orphans.length} 天 ` +
        `portfolioId=${portfolioId} dates=[${orphans.map(fmt).join(', ')}]`,
    );

    return orphans.length;
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
