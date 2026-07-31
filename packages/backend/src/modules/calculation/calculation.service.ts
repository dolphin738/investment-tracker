/**
 * 计算编排服务
 *
 * 职责：
 * - triggerCalculation：触发单日计算（净值 + XIRR），快照录入/修改时调用
 * - ensureBaseDate：首次计算时自动设置组合成立日（首笔买入日）
 *
 * 计算顺序：先净值后 XIRR（两者无相互依赖，但净值结果存储后 XIRR 可独立计算）
 *
 * 依赖方向（无循环依赖）：
 *   Transaction/SnapshotService → CalculationService → NavService + XirrService → PrismaService
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NavService } from './nav.service';
import { XirrService } from './xirr.service';

@Injectable()
export class CalculationService {
  private readonly logger = new Logger(CalculationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly navService: NavService,
    private readonly xirrService: XirrService,
  ) {}

  /**
   * 触发单日计算：净值 → XIRR
   *
   * 快照录入/修改时调用。若当日无快照，则不计算（NavService 返回 null）。
   * XIRR 无论净值是否成功都会尝试计算（只要当日有快照就能构建现金流）。
   */
  async triggerCalculation(portfolioId: string, date: Date): Promise<void> {
    // 1. 确保组合成立日已设置
    await this.ensureBaseDate(portfolioId);

    // 2. 计算并存储净值
    try {
      const navResult = await this.navService.calculateNavForDate(portfolioId, date);
      if (navResult) {
        await this.prisma.dailyNav.upsert({
          where: { portfolioId_date: { portfolioId, date } },
          create: {
            portfolioId,
            date,
            unitNav: navResult.unitNav,
            cumulativeNav: navResult.cumulativeNav,
            yearNav: navResult.yearNav,
            shares: navResult.shares,
            baseCumulativeNav: navResult.baseCumulativeNav,
          },
          update: {
            unitNav: navResult.unitNav,
            cumulativeNav: navResult.cumulativeNav,
            yearNav: navResult.yearNav,
            shares: navResult.shares,
            baseCumulativeNav: navResult.baseCumulativeNav,
          },
        });
      }
    } catch (error) {
      this.logger.error(
        `净值计算失败 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}: ${(error as Error).message}`,
      );
      throw error;
    }

    // 3. 计算并存储 XIRR
    try {
      const xirrValue = await this.xirrService.calculateXirrForDate(portfolioId, date);
      // 防御：XIRR 值溢出 NUMERIC(20, 8) 时存 null（合理值范围 ±10^11）
      const safeXirr =
        xirrValue !== null && (xirrValue > 1e11 || xirrValue < -1e11) ? null : xirrValue;
      await this.prisma.dailyXirr.upsert({
        where: { portfolioId_date: { portfolioId, date } },
        create: {
          portfolioId,
          date,
          xirrValue: safeXirr,
        },
        update: {
          xirrValue: safeXirr,
        },
      });
    } catch (error) {
      this.logger.error(
        `XIRR 计算失败 portfolioId=${portfolioId} date=${date.toISOString().split('T')[0]}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * 确保组合的成立日（baseDate）已设置
   *
   * 首次录入买入交易时，将组合的 baseDate 设为该首笔买入日。
   * 设置后不可更改。
   */
  private async ensureBaseDate(portfolioId: string): Promise<void> {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
      select: { baseDate: true },
    });

    if (portfolio && !portfolio.baseDate) {
      const firstBuy = await this.prisma.transaction.findFirst({
        where: { portfolioId, type: 'BUY' },
        orderBy: { date: 'asc' },
      });

      if (firstBuy) {
        await this.prisma.portfolio.update({
          where: { id: portfolioId },
          data: { baseDate: firstBuy.date },
        });
        this.logger.log(
          `设置组合成立日 portfolioId=${portfolioId} baseDate=${firstBuy.date.toISOString().split('T')[0]}`,
        );
      }
    }
  }
}
