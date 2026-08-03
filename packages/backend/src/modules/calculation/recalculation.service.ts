/**
 * 批量重算服务
 *
 * 职责：
 * - recalculateFromDate：从指定日期起，按日期升序逐日重算净值 + XIRR
 * - recalculateAll：从组合成立日（第一笔买入日）起全量重算
 *
 * 触发场景：
 * - 新增/修改/删除交易 → 从受影响日期起批量重算
 * - 录入（覆盖）/删除快照 → 从受影响日期起批量重算
 * - 计算口径变更、历史数据修复 → 全量重算（recalculateAll）
 *
 * 重要：净值计算有前日依赖（当日份额依赖上日份额），
 * 必须按日期升序逐日计算，不能并行。
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CalculationService } from './calculation.service';

/** 批量重算结果 */
export interface RecalculationResult {
  /** 受影响日期数（即重算的快照日期数） */
  affectedDates: number;
}

/** 全量重算结果 */
export interface FullRecalculationResult {
  /** 重算起始日期（组合成立日 = 第一笔买入日） */
  fromDate: Date;
  /** 受影响日期数（即重算的快照日期数） */
  affectedDays: number;
}

@Injectable()
export class RecalculationService {
  private readonly logger = new Logger(RecalculationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculationService: CalculationService,
  ) {}

  /**
   * 从指定日期起批量重算
   *
   * 查询 [startDate, endDate?] 范围内的所有快照日期，
   * 按日期升序逐日调用 triggerCalculation（净值+XIRR）。
   *
   * 注意：startDate 当日不必有快照 —— 该日若无快照则自然跳过，
   * 但其后所有有快照的日期都会被重算（补录历史交易时依赖此行为）。
   *
   * @param portfolioId 组合 ID
   * @param startDate 起始日期（含）
   * @param endDate 结束日期（含），不传则重算到最新
   * @returns 受影响的日期数
   */
  async recalculateFromDate(
    portfolioId: string,
    startDate: Date,
    endDate?: Date,
  ): Promise<RecalculationResult> {
    const snapshots = await this.prisma.assetSnapshot.findMany({
      where: {
        portfolioId,
        date: {
          gte: startDate,
          ...(endDate ? { lte: endDate } : {}),
        },
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    this.logger.log(
      `开始批量重算 portfolioId=${portfolioId} startDate=${startDate.toISOString().split('T')[0]} affectedDates=${snapshots.length}`,
    );

    // 按日期升序逐日重算（净值有前日依赖，不能并行）
    for (const snapshot of snapshots) {
      await this.calculationService.triggerCalculation(portfolioId, snapshot.date);
    }

    this.logger.log(
      `批量重算完成 portfolioId=${portfolioId} processed=${snapshots.length}`,
    );

    return { affectedDates: snapshots.length };
  }

  /**
   * 🔴 T02→T03 契约：从指定日期起级联重算净值 + XIRR
   *
   * 与 recalculateFromDate 等效，但使用更简洁的 (portfolioId, date) 签名，
   * 供 CashFlow / SecurityTrade / SecurityPrice / CashBalance 等 CRUD 模块调用。
   *
   * @param portfolioId 组合 ID
   * @param date 起始日期
   */
  async recalculateRange(
    portfolioId: string,
    date: Date,
  ): Promise<RecalculationResult> {
    return this.recalculateFromDate(portfolioId, date);
  }

  /**
   * 🔴 T02→T03 契约：从指定日期起重算 NAV（净值链）
   *
   * 供 Snapshot 模块 T5 手工三路径（upsert/delete/reset）调用。
   * 当前实现等效于 recalculateRange，T03 可细化为仅重算 NAV 不重算 XIRR。
   *
   * @param portfolioId 组合 ID
   * @param date 起始日期
   */
  async recalculateNavRange(
    portfolioId: string,
    date: Date,
  ): Promise<RecalculationResult> {
    return this.recalculateFromDate(portfolioId, date);
  }

  /**
   * 全量重算：从组合成立日（第一笔买入日）重算到最后一个有快照的日期
   *
   * 使用场景：计算口径变更（如 D-06 资产快照口径调整）后，
   * 历史净值/XIRR 全部失效，需要一次性重建。
   *
   * 实现复用 recalculateFromDate 的逐日升序逻辑，不另写一套。
   * 不传 endDate 即自动重算到最后一个有快照的日期。
   *
   * @param portfolioId 组合 ID
   * @returns 重算起始日期与受影响日期数
   * @throws BadRequestException 组合尚无买入交易（成立日无法确定）
   */
  async recalculateAll(portfolioId: string): Promise<FullRecalculationResult> {
    // 成立日 = 第一笔买入交易日（与 CalculationService.ensureBaseDate 口径一致）
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

    const { affectedDates } = await this.recalculateFromDate(portfolioId, fromDate);

    this.logger.log(
      `全量重算完成 portfolioId=${portfolioId} affectedDays=${affectedDates}`,
    );

    return { fromDate, affectedDays: affectedDates };
  }
}
