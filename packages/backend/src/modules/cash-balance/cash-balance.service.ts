/**
 * CashBalance Service — 现金余额 CRUD
 *
 * 方案B：CashBalance 独立管理（零联动），前向沿用。
 * asOf ≤ 目标日期的最后一条为当前现金余额。
 *
 * 🔴 写入后触发 recalculateRange
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CashBalance as PrismaCashBalance } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../calculation/recalculation.service';
import type { UpsertCashBalanceDto, CashBalanceQueryDto } from './cash-balance.dto';

/** API 响应中的现金余额结构 */
export interface CashBalanceResponse {
  id: string;
  portfolioId: string;
  amount: string;
  asOf: string;
  note: string | null;
  createdAt: string;
}

function toResponse(cb: PrismaCashBalance): CashBalanceResponse {
  return {
    id: cb.id,
    portfolioId: cb.portfolioId,
    amount: cb.amount.toString(),
    asOf: cb.asOf.toISOString().split('T')[0],
    note: cb.note,
    createdAt: cb.createdAt.toISOString(),
  };
}

@Injectable()
export class CashBalanceService {
  private readonly logger = new Logger(CashBalanceService.name);

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

  /**
   * 录入/覆盖现金余额（upsert：同一 (portfolioId, asOf) 删除旧记录再创建）
   *
   * 🔴 写入后触发 recalculateRange
   */
  async upsert(
    userId: string,
    portfolioId: string,
    dto: UpsertCashBalanceDto,
  ): Promise<CashBalanceResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const asOf = new Date(dto.asOf);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (asOf > today) {
      throw new BadRequestException('日期不能为未来日期');
    }

    // 删除同一日期的旧余额
    await this.prisma.cashBalance.deleteMany({
      where: { portfolioId, asOf },
    });

    const balance = await this.prisma.cashBalance.create({
      data: {
        portfolioId,
        amount: dto.amount,
        asOf,
        note: dto.note,
      },
    });

    // 🔴 触发重算
    await this.recalculationService.recalculateRange(portfolioId, asOf);

    return toResponse(balance);
  }

  /**
   * 查询现金余额列表（分页 + 日期范围）
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: CashBalanceQueryDto,
  ): Promise<{ items: CashBalanceResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { portfolioId };
    if (query.startDate || query.endDate) {
      where.asOf = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.cashBalance.findMany({
        where,
        orderBy: { asOf: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cashBalance.count({ where }),
    ]);

    return { items: items.map(toResponse), total, page, pageSize };
  }

  /**
   * 删除现金余额记录
   *
   * 🔴 副作用：触发 recalculateRange
   */
  async remove(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<null> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.cashBalance.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('现金余额记录不存在');
    }

    const recalcDate = existing.asOf;
    await this.prisma.cashBalance.delete({ where: { id } });

    // 🔴 触发重算
    await this.recalculationService.recalculateRange(portfolioId, recalcDate);

    return null;
  }
}
