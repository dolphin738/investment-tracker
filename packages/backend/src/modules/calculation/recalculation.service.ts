/**
 * 批量重算服务
 *
 * 职责：
 * - recalculateFromDate：从指定日期起，按日期升序逐日重算净值 + XIRR
 *
 * 触发场景：
 * - 修改/删除历史交易 → 从受影响日期起批量重算
 * - 修改/删除历史快照 → 从受影响日期起批量重算
 *
 * 重要：净值计算有前日依赖（当日份额依赖上日份额），
 * 必须按日期升序逐日计算，不能并行。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CalculationService } from './calculation.service';

/** 批量重算结果 */
export interface RecalculationResult {
  /** 受影响日期数（即重算的快照日期数） */
  affectedDates: number;
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
}
