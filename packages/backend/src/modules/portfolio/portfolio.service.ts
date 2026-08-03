/**
 * 组合管理服务
 *
 * 职责：
 * - 组合 CRUD（创建 / 查询列表 / 查询单个 / 更新 / 删除）
 * - 数据隔离：所有查询以 userId 过滤，用户只能操作自己的组合
 * - 创建时固定 currency = 'CNY'（v1 单币种）
 * - 全量重算入口（recalculateAll）：口径变更/数据修复后重建全部历史净值与 XIRR
 *
 * Decimal/Date 序列化：
 * - baseDate（@db.Date）转为 YYYY-MM-DD 字符串
 * - createdAt/updatedAt（DateTime）转为 ISO 8601 字符串
 */

import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Portfolio as PrismaPortfolio } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../calculation/recalculation.service';
import type { PortfolioSummaryDto } from './dto/portfolio-summary.dto';
import type { ArchivePortfolioDto } from './dto/archive-portfolio.dto';

/** API 响应中的组合结构（日期字段转为字符串） */
export interface PortfolioResponse {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  baseDate: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应（日期 → 字符串） */
function toResponse(p: PrismaPortfolio): PortfolioResponse {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description,
    baseDate: p.baseDate ? p.baseDate.toISOString().split('T')[0] : null,
    currency: p.currency,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** 全量重算 API 响应 */
export interface RecalculateResponse {
  /** 组合 ID */
  portfolioId: string;
  /** 重算起始日期 YYYY-MM-DD（组合成立日 = 第一笔买入日） */
  fromDate: string;
  /** 受影响日期数（重算的快照日期数） */
  affectedDays: number;
}

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /**
   * 创建组合（currency 固定为 CNY）
   */
  async create(userId: string, name: string, description?: string): Promise<PortfolioResponse> {
    const portfolio = await this.prisma.portfolio.create({
      data: {
        userId,
        name,
        description,
        currency: 'CNY',
      },
    });
    return toResponse(portfolio);
  }

  /**
   * 获取当前用户的所有组合
   */
  async findAll(userId: string): Promise<PortfolioResponse[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return portfolios.map(toResponse);
  }

  /**
   * 获取单个组合（含数据隔离校验）
   *
   * @throws NotFoundException 组合不存在或不属于当前用户
   */
  async findOne(userId: string, id: string): Promise<PortfolioResponse> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
    return toResponse(portfolio);
  }

  /**
   * 更新组合（仅 name / description）
   */
  async update(
    userId: string,
    id: string,
    data: { name?: string; description?: string },
  ): Promise<PortfolioResponse> {
    await this.findOne(userId, id);

    const updated = await this.prisma.portfolio.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
    return toResponse(updated);
  }

  /**
   * 清空组合全部业务数据（SET-P0-05 危险操作区 · 保留组合本身）
   *
   * 删除：出入金 / 证券买卖流水 / 标的最新价 / 现金余额 / 总资产记录 /
   *       每日净值 / 每日 XIRR / 分红 / 费用。
   * 保留：组合本身与标的主数据（securities 仅剩空壳，可继续录入新交易）。
   * 重置：Portfolio.baseDate = null。
   *
   * 说明：派生表（snapshots/dailyNavs/dailyXirr）直接删除即可，
   * 无需再触发全量重算（重算依赖「第一笔买入」，清空后必然不存在，调用会 400）。
   * 后续重新录入数据时，CRUD 模块会自动按需重算。
   *
   * @throws NotFoundException 组合不存在或不属于当前用户
   */
  async clearData(userId: string, id: string): Promise<null> {
    await this.findOne(userId, id);

    await this.prisma.$transaction([
      this.prisma.cashFlow.deleteMany({ where: { portfolioId: id } }),
      this.prisma.securityTrade.deleteMany({ where: { portfolioId: id } }),
      this.prisma.securityPrice.deleteMany({ where: { portfolioId: id } }),
      this.prisma.cashBalance.deleteMany({ where: { portfolioId: id } }),
      this.prisma.assetSnapshot.deleteMany({ where: { portfolioId: id } }),
      this.prisma.dailyNav.deleteMany({ where: { portfolioId: id } }),
      this.prisma.dailyXirr.deleteMany({ where: { portfolioId: id } }),
      this.prisma.dividendRecord.deleteMany({ where: { portfolioId: id } }),
      this.prisma.feeRecord.deleteMany({ where: { portfolioId: id } }),
    ]);

    await this.prisma.portfolio.update({
      where: { id },
      data: { baseDate: null },
    });

    return null;
  }

  /**
   * 删除组合（级联删除其下所有交易/快照/净值/XIRR）
   */
  async remove(userId: string, id: string): Promise<null> {
    await this.findOne(userId, id);
    await this.prisma.portfolio.delete({ where: { id } });
    return null;
  }

  /**
   * 归档 / 取消归档组合
   *
   * 语义（见 ArchivePortfolioDto）：
   * - dto.archived 缺省或 true → 归档（archivedAt = now）
   * - dto.archived === false   → 取消归档（archivedAt = null）
   *
   * 数据隔离：先 findOne(userId, id) 校验归属，再用唯一键 id 更新。
   */
  async archive(
    userId: string,
    id: string,
    dto: ArchivePortfolioDto,
  ): Promise<PortfolioResponse> {
    await this.findOne(userId, id);

    const updated = await this.prisma.portfolio.update({
      where: { id },
      data: {
        archivedAt: dto.archived === false ? null : new Date(),
      },
    });
    return toResponse(updated);
  }

  /**
   * 获取全部组合摘要（name/id/总资产/持仓数/最近更新时间）— 方案B
   *
   * 供概览页对比（DASH-P1-01）+ 账户页列表（ACC-P0-04）共用。
   * 方案B：持仓数从 security_trades 推导（当前有正持仓的去重标的数）。
   * 最近更新时间取 snapshots 与 security_trades 的最晚日期。
   */
  async getSummary(userId: string): Promise<PortfolioSummaryDto[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      include: {
        snapshots: {
          orderBy: { date: 'desc' },
          take: 1,
          select: { totalAsset: true, date: true },
        },
        securityTrades: {
          orderBy: { date: 'desc' },
          take: 1,
          select: { date: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 批量获取各组合的持仓标的数（方案B：从 security_trades 推导）
    const portfolioIds = portfolios.map((p) => p.id);
    const holdingsCounts = portfolioIds.length > 0
      ? await Promise.all(
          portfolioIds.map(async (pid) => {
            // 获取该组合所有标的的买入/卖出汇总
            const trades = await this.prisma.securityTrade.findMany({
              where: { portfolioId: pid },
              select: { securityId: true, side: true, quantity: true },
            });

            // 按标的汇总净持仓
            const qtyMap = new Map<string, number>();
            for (const t of trades) {
              const qty = Number(t.quantity);
              const current = qtyMap.get(t.securityId) ?? 0;
              qtyMap.set(
                t.securityId,
                t.side === 'BUY_SEC' ? current + qty : current - qty,
              );
            }

            // 正持仓标的数
            let count = 0;
            for (const qty of qtyMap.values()) {
              if (qty > 0) count++;
            }
            return { pid, count };
          }),
        )
      : [];

    const countMap = new Map(holdingsCounts.map((h) => [h.pid, h.count]));

    return portfolios.map((p) => {
      const latestSnapshot = p.snapshots[0] ?? null;
      const latestTrade = p.securityTrades[0] ?? null;

      // 计算最近更新时间
      let lastUpdatedAt: string | null = null;
      if (latestSnapshot && latestTrade) {
        lastUpdatedAt =
          latestSnapshot.date > latestTrade.date
            ? latestSnapshot.date.toISOString().split('T')[0]
            : latestTrade.date.toISOString().split('T')[0];
      } else if (latestSnapshot) {
        lastUpdatedAt = latestSnapshot.date.toISOString().split('T')[0];
      } else if (latestTrade) {
        lastUpdatedAt = latestTrade.date.toISOString().split('T')[0];
      }

      return {
        id: p.id,
        name: p.name,
        totalAsset: latestSnapshot?.totalAsset.toString() ?? '0',
        holdingsCount: countMap.get(p.id) ?? 0,
        lastUpdatedAt,
      };
    });
  }

  /**
   * 全量重算：从组合成立日重算到最后一个有快照的日期
   *
   * 使用场景：计算口径变更（如 D-06 资产快照口径调整）后历史净值/XIRR 全部失效，
   * 需要一次性重建。
   *
   * @throws NotFoundException 组合不存在或不属于当前用户
   * @throws BadRequestException 组合尚无买入交易（由 RecalculationService 抛出）
   */
  async recalculateAll(userId: string, id: string): Promise<RecalculateResponse> {
    // 数据隔离：仅允许重算属于当前用户的组合
    await this.findOne(userId, id);

    const { fromDate, affectedDays } = await this.recalculationService.recalculateAll(id);

    return {
      portfolioId: id,
      fromDate: fromDate.toISOString().split('T')[0],
      affectedDays,
    };
  }
}
