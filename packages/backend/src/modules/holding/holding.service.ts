/**
 * 持仓管理服务
 *
 * 职责：
 * - 持仓快照 CRUD（create / findAll / upsert / delete）
 * - 持仓汇总（getAggregate）：总市值 / 总成本 / 总盈亏
 * - 数据隔离：所有查询以 portfolioId + userId 过滤
 *
 * ⚠️ 约束（C-09）：
 * - 本模块不导入 CalculationModule
 * - 持仓写操作不触发任何 NAV / XIRR 计算
 * - 派生字段（marketValue / profit / weight）仅在前端/API 响应中计算，不落库
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { UpsertHoldingDto } from './dto/upsert-holding.dto';
import type { HoldingQueryDto } from './dto/holding-query.dto';
import { Prisma } from '@prisma/client';

/** 持仓响应（含派生字段） */
export interface HoldingResponse {
  id: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  securityType: string;
  date: string;
  quantity: string;
  avgCost: string;
  marketPrice: string;
  costAmount: string;
  marketValue: string;
  profit: string;
  profitRate: string;
  weight: string;
  note: string | null;
}

/** 持仓汇总 */
export interface HoldingsAggregate {
  date: string;
  totalMarketValue: string;
  totalCost: string;
  totalProfit: string;
  totalProfitRate: string;
  securityCount: number;
}

@Injectable()
export class HoldingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 验证组合归属权（数据隔离）
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
   * 查询持仓明细（含派生字段）
   *
   * @param portfolioId 组合 ID
   * @param userId 用户 ID
   * @param query 查询参数（日期 + 类型筛选）
   */
  async findAllByPortfolio(
    portfolioId: string,
    userId: string,
    query?: HoldingQueryDto,
  ): Promise<{ items: HoldingResponse[]; aggregate: HoldingsAggregate }> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    // 确定查询日期
    let targetDate: Date;
    if (query?.date) {
      targetDate = new Date(query.date);
    } else {
      // 默认取最新有持仓数据的日期
      const latest = await this.prisma.holding.findFirst({
        where: { portfolioId },
        orderBy: { date: 'desc' },
        select: { date: true },
      });
      if (!latest) {
        return {
          items: [],
          aggregate: {
            date: query?.date ?? new Date().toISOString().split('T')[0],
            totalMarketValue: '0',
            totalCost: '0',
            totalProfit: '0',
            totalProfitRate: '0',
            securityCount: 0,
          },
        };
      }
      targetDate = latest.date;
    }

    // 构建 where 条件
    const where: Prisma.HoldingWhereInput = {
      portfolioId,
      date: targetDate,
    };

    // JOIN Security 表获取标的名称/代码/类型
    const holdings = await this.prisma.holding.findMany({
      where,
      include: {
        security: {
          select: { id: true, code: true, name: true, type: true },
        },
      },
      orderBy: { security: { code: 'asc' } },
    });

    // 按类型筛选
    const filtered =
      query?.types && query.types.length > 0
        ? holdings.filter((h) => query.types!.includes(h.security.type))
        : holdings;

    // 计算所有持仓总市值
    let totalMarketValue = 0;
    const withDerived: HoldingResponse[] = [];

    for (const h of filtered) {
      const qty = Number(h.quantity);
      const avgC = Number(h.avgCost);
      const mktP = Number(h.marketPrice);

      const costAmount = qty * avgC;
      const marketValue = qty * mktP;
      const profit = marketValue - costAmount;
      const profitRate = costAmount !== 0 ? profit / costAmount : 0;

      withDerived.push({
        id: h.id,
        securityId: h.securityId,
        securityName: h.security.name,
        securityCode: h.security.code,
        securityType: h.security.type,
        date: h.date.toISOString().split('T')[0],
        quantity: h.quantity.toString(),
        avgCost: h.avgCost.toString(),
        marketPrice: h.marketPrice.toString(),
        costAmount: costAmount.toFixed(2),
        marketValue: marketValue.toFixed(2),
        profit: profit.toFixed(2),
        profitRate: profitRate.toFixed(4),
        weight: '0', // 下面统一计算
        note: h.note,
      });

      totalMarketValue += marketValue;
    }

    // 计算占比（weight）
    for (const item of withDerived) {
      const mv = Number(item.marketValue);
      item.weight =
        totalMarketValue > 0
          ? (mv / totalMarketValue).toFixed(4)
          : '0';
    }

    // 计算汇总
    const totalCost = withDerived.reduce(
      (sum, item) => sum + Number(item.costAmount),
      0,
    );
    const totalProfit = totalMarketValue - totalCost;
    const totalProfitRate = totalCost !== 0 ? totalProfit / totalCost : 0;

    return {
      items: withDerived,
      aggregate: {
        date: targetDate.toISOString().split('T')[0],
        totalMarketValue: totalMarketValue.toFixed(2),
        totalCost: totalCost.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        totalProfitRate: totalProfitRate.toFixed(4),
        securityCount: withDerived.filter((item) => Number(item.quantity) > 0).length,
      },
    };
  }

  /**
   * 持仓 upsert（单条，以 securityId + date 为唯一键）
   *
   * ⚠️ 不触发任何计算引擎（C-09 约束）
   */
  async upsert(
    portfolioId: string,
    userId: string,
    dto: UpsertHoldingDto,
  ): Promise<HoldingResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    // 校验：日期不可为未来
    const dateObj = new Date(dto.date);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (dateObj > today) {
      throw new BadRequestException('日期不可为未来');
    }

    // 校验数值
    if (Number(dto.quantity) < 0) {
      throw new BadRequestException('持仓数量不可为负数');
    }
    if (Number(dto.avgCost) < 0) {
      throw new BadRequestException('成本价不可为负数');
    }
    if (Number(dto.marketPrice) < 0) {
      throw new BadRequestException('现价不可为负数');
    }

    // 使用 securityId + date 做 upsert
    const holding = await this.prisma.holding.upsert({
      where: {
        securityId_date: {
          securityId: dto.securityId,
          date: dateObj,
        },
      },
      create: {
        portfolioId,
        securityId: dto.securityId,
        date: dateObj,
        quantity: dto.quantity,
        avgCost: dto.avgCost,
        marketPrice: dto.marketPrice,
        note: dto.note,
      },
      update: {
        quantity: dto.quantity,
        avgCost: dto.avgCost,
        marketPrice: dto.marketPrice,
        note: dto.note ?? null,
      },
      include: {
        security: {
          select: { id: true, code: true, name: true, type: true },
        },
      },
    });

    // 计算派生字段（单条不需要 weight）
    const qty = Number(holding.quantity);
    const avgC = Number(holding.avgCost);
    const mktP = Number(holding.marketPrice);
    const costAmount = qty * avgC;
    const marketValue = qty * mktP;
    const profit = marketValue - costAmount;
    const profitRate = costAmount !== 0 ? profit / costAmount : 0;

    return {
      id: holding.id,
      securityId: holding.securityId,
      securityName: holding.security.name,
      securityCode: holding.security.code,
      securityType: holding.security.type,
      date: holding.date.toISOString().split('T')[0],
      quantity: holding.quantity.toString(),
      avgCost: holding.avgCost.toString(),
      marketPrice: holding.marketPrice.toString(),
      costAmount: costAmount.toFixed(2),
      marketValue: marketValue.toFixed(2),
      profit: profit.toFixed(2),
      profitRate: profitRate.toFixed(4),
      weight: '0', // 单条 upsert 时无法计算占比
      note: holding.note,
    };
  }

  /**
   * 获取持仓汇总（总市值 / 总成本 / 总盈亏）
   */
  async getAggregate(
    portfolioId: string,
    userId: string,
    date?: string,
  ): Promise<HoldingsAggregate> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    let targetDate: Date;
    if (date) {
      targetDate = new Date(date);
    } else {
      const latest = await this.prisma.holding.findFirst({
        where: { portfolioId },
        orderBy: { date: 'desc' },
        select: { date: true },
      });
      if (!latest) {
        return {
          date: date ?? new Date().toISOString().split('T')[0],
          totalMarketValue: '0',
          totalCost: '0',
          totalProfit: '0',
          totalProfitRate: '0',
          securityCount: 0,
        };
      }
      targetDate = latest.date;
    }

    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId, date: targetDate },
    });

    let totalMarketValue = 0;
    let totalCost = 0;
    let securityCount = 0;

    for (const h of holdings) {
      const qty = Number(h.quantity);
      if (qty <= 0) continue; // 跳过已清仓
      totalMarketValue += qty * Number(h.marketPrice);
      totalCost += qty * Number(h.avgCost);
      securityCount++;
    }

    const totalProfit = totalMarketValue - totalCost;
    const totalProfitRate = totalCost !== 0 ? totalProfit / totalCost : 0;

    return {
      date: targetDate.toISOString().split('T')[0],
      totalMarketValue: totalMarketValue.toFixed(2),
      totalCost: totalCost.toFixed(2),
      totalProfit: totalProfit.toFixed(2),
      totalProfitRate: totalProfitRate.toFixed(4),
      securityCount,
    };
  }

  /**
   * 删除单条持仓记录
   *
   * ⚠️ 不触发任何计算引擎（C-09 约束）
   */
  async remove(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<null> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const holding = await this.prisma.holding.findFirst({
      where: { id, portfolioId },
    });
    if (!holding) {
      throw new NotFoundException('持仓记录不存在');
    }

    await this.prisma.holding.delete({ where: { id } });
    return null;
  }

  /**
   * 获取有持仓数据的日期列表（供日期选择器）
   */
  async getAvailableDates(
    portfolioId: string,
    userId: string,
  ): Promise<string[]> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const dates = await this.prisma.holding.findMany({
      where: { portfolioId },
      select: { date: true },
      distinct: ['date'],
      orderBy: { date: 'desc' },
    });

    return dates.map((d) => d.date.toISOString().split('T')[0]);
  }
}
