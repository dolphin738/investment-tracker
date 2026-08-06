/**
 * SecurityTrade Service — 证券买卖流水 CRUD
 *
 * 方案B：SecurityTrade 是持仓推导唯一来源。
 * 所有查询以 portfolioId + userId 双重过滤实现数据隔离。
 *
 * 🔴 卖出硬校验：卖出数量不得超持仓（从 security_trades 推导当前持仓）
 * 🔴 写入后触发 RecalculationService.recalculateRange(portfolioId, date)
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { SecurityTrade as PrismaSecurityTrade } from '@prisma/client';
import { SecuritySide } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../recalculation/recalculation.service';
import type {
  CreateSecurityTradeDto,
  UpdateSecurityTradeDto,
  SecurityTradeQueryDto,
} from './security-trade.dto';

/** API 响应中的证券买卖流水结构 */
export interface SecurityTradeResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  date: string;
  side: string;
  quantity: string;
  price: string;
  fee: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应 */
function toResponse(t: PrismaSecurityTrade): SecurityTradeResponse {
  return {
    id: t.id,
    portfolioId: t.portfolioId,
    securityId: t.securityId,
    date: t.date.toISOString().split('T')[0],
    side: t.side,
    quantity: t.quantity.toString(),
    price: t.price.toString(),
    fee: t.fee.toString(),
    note: t.note,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

@Injectable()
export class SecurityTradeService {
  private readonly logger = new Logger(SecurityTradeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /** 验证组合归属（数据隔离） */
  private async verifyOwnership(userId: string, portfolioId: string): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  /** 校验日期不为未来 */
  private validateDateNotFuture(dateStr: string): void {
    const inputDate = new Date(dateStr);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (inputDate > today) {
      throw new BadRequestException('日期不能为未来日期');
    }
  }

  /**
   * 🔴 从 security_trades 推导指定日期之前的持仓量
   *
   * 方案B：持仓 = Σ BUY_SEC - Σ SELL_SEC，从成立日到交易日期的累积量。
   * 这里统计截至 date（不含当日新交易，用于卖出前校验）。
   */
  private async deriveHoldingBeforeDate(
    portfolioId: string,
    securityId: string,
    beforeDate: Date,
  ): Promise<number> {
    const trades = await this.prisma.securityTrade.findMany({
      where: {
        portfolioId,
        securityId,
        date: { lt: beforeDate },
      },
      select: { side: true, quantity: true },
    });

    let holding = 0;
    for (const t of trades) {
      const qty = Number(t.quantity);
      if (t.side === SecuritySide.BUY_SEC) {
        holding += qty;
      } else {
        holding -= qty;
      }
    }
    return holding;
  }

  /**
   * 🔴 卖出硬校验：卖出数量不得超持仓
   *
   * 统计范围为 date 之前的所有交易（不含当日，因为当日交易可能有多笔）。
   * 同时减去当日已有的卖出量（同一日多笔卖出叠加校验）。
   */
  private async validateSellQuantity(
    portfolioId: string,
    securityId: string,
    date: Date,
    quantity: number,
    excludeTradeId?: string,
  ): Promise<void> {
    // 截至前日的持仓
    let holding = await this.deriveHoldingBeforeDate(portfolioId, securityId, date);

    // 减去当日已有的卖出量（同一日多笔卖出叠加校验）
    const sameDayTrades = await this.prisma.securityTrade.findMany({
      where: {
        portfolioId,
        securityId,
        date,
        ...(excludeTradeId ? { id: { not: excludeTradeId } } : {}),
      },
      select: { side: true, quantity: true },
    });

    for (const t of sameDayTrades) {
      const qty = Number(t.quantity);
      if (t.side === SecuritySide.BUY_SEC) {
        holding += qty;
      } else {
        holding -= qty;
      }
    }

    if (holding < quantity) {
      throw new BadRequestException(
        `卖出数量超持仓：当前持仓 ${holding}，卖出 ${quantity}（含当日已卖出 ${holding < 0 ? holding + quantity : 0}）`,
      );
    }
  }

  /**
   * 创建证券买卖流水
   *
   * 🔴 卖出前校验持仓量
   * 🔴 写入后触发 recalculateRange
   */
  async create(
    userId: string,
    portfolioId: string,
    dto: CreateSecurityTradeDto,
  ): Promise<SecurityTradeResponse> {
    await this.verifyOwnership(userId, portfolioId);
    this.validateDateNotFuture(dto.date);

    const date = new Date(dto.date);

    // 🔴 卖出硬校验
    if (dto.side === SecuritySide.SELL_SEC) {
      await this.validateSellQuantity(portfolioId, dto.securityId, date, dto.quantity);
    }

    const trade = await this.prisma.securityTrade.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        date,
        side: dto.side,
        quantity: dto.quantity,
        price: dto.price,
        // 增量设计 C-5/K-4：trade.fee 新口径恒为 0（含费单价存入 price，
        // 费用拆分落 FeeRecord 由前端编排 POST /fees 完成）；忽略 DTO.fee
        fee: 0,
        note: dto.note,
      },
    });

    // 🔴 触发重算
    await this.recalculationService.recalculateRange(portfolioId, date);

    return toResponse(trade);
  }

  /**
   * 查询证券买卖流水列表（分页 + 日期范围 + 标的筛选）
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: SecurityTradeQueryDto,
  ): Promise<{ items: SecurityTradeResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { portfolioId };
    if (query.securityId) {
      where.securityId = query.securityId;
    }
    if (query.side) {
      where.side = query.side;
    }
    if (query.startDate || query.endDate) {
      where.date = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.securityTrade.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.securityTrade.count({ where }),
    ]);

    return { items: items.map(toResponse), total, page, pageSize };
  }

  /**
   * 获取单条证券买卖流水
   */
  async findOne(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<SecurityTradeResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const trade = await this.prisma.securityTrade.findFirst({
      where: { id, portfolioId },
    });
    if (!trade) {
      throw new NotFoundException('证券交易记录不存在');
    }
    return toResponse(trade);
  }

  /**
   * 更新证券买卖流水
   *
   * 🔴 若改为卖出，校验持仓量
   * 🔴 写入后触发 recalculateRange
   */
  async update(
    userId: string,
    portfolioId: string,
    id: string,
    dto: UpdateSecurityTradeDto,
  ): Promise<SecurityTradeResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.securityTrade.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('证券交易记录不存在');
    }

    const newDate = dto.date ? new Date(dto.date) : existing.date;
    if (dto.date) {
      this.validateDateNotFuture(dto.date);
    }

    const newSide = dto.side ?? existing.side;
    const newQuantity = dto.quantity ?? Number(existing.quantity);
    const newSecurityId = dto.securityId ?? existing.securityId;

    // 🔴 卖出硬校验（排除当前记录自身的量）
    if (newSide === SecuritySide.SELL_SEC) {
      await this.validateSellQuantity(
        portfolioId,
        newSecurityId,
        newDate,
        newQuantity,
        id,
      );
    }

    const updated = await this.prisma.securityTrade.update({
      where: { id },
      data: {
        ...(dto.securityId !== undefined && { securityId: dto.securityId }),
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(dto.side !== undefined && { side: dto.side }),
        ...(dto.quantity !== undefined && { quantity: dto.quantity }),
        ...(dto.price !== undefined && { price: dto.price }),
        // 增量设计 C-5/U-1：update 忽略 fee 字段（保留现值，存量 fee≠0 不丢失）
        ...(dto.note !== undefined && { note: dto.note }),
      },
    });

    // 🔴 触发重算：从新旧日期中较早的开始
    const recalcDate = new Date(Math.min(newDate.getTime(), existing.date.getTime()));
    await this.recalculationService.recalculateRange(portfolioId, recalcDate);

    return toResponse(updated);
  }

  /**
   * 删除证券买卖流水
   *
   * 🔴 副作用：触发 recalculateRange
   */
  async remove(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<null> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.securityTrade.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('证券交易记录不存在');
    }

    const recalcDate = existing.date;
    await this.prisma.securityTrade.delete({ where: { id } });

    // 🔴 触发重算
    await this.recalculationService.recalculateRange(portfolioId, recalcDate);

    return null;
  }
}
