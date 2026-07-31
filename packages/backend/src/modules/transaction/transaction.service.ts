/**
 * 交易管理服务
 *
 * 职责：
 * - 交易 CRUD（创建 / 查询列表 / 查询单个 / 更新 / 删除）
 * - 数据隔离：通过 verifyOwnership 校验组合归属
 * - 校验：金额 > 0、日期非未来、首笔必须买入
 * - 计算触发：
 *   - 创建交易 → 若当日有快照，触发当日计算
 *   - 更新交易 → 从 min(原日期, 新日期) 起批量重算
 *   - 删除交易 → 从原交易日期起批量重算
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Transaction as PrismaTransaction } from '@prisma/client';
import { TransactionType } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CalculationService } from '../calculation/calculation.service';
import { RecalculationService } from '../calculation/recalculation.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { DateRangeDto } from '../../common/dto/date-range.dto';

/** API 响应中的交易结构 */
export interface TransactionResponse {
  id: string;
  portfolioId: string;
  date: string;
  type: TransactionType;
  amount: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应 */
function toResponse(t: PrismaTransaction): TransactionResponse {
  return {
    id: t.id,
    portfolioId: t.portfolioId,
    date: t.date.toISOString().split('T')[0],
    type: t.type,
    amount: t.amount.toString(),
    note: t.note,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** 交易列表查询参数 */
export interface TransactionQuery extends PaginationDto, DateRangeDto {}

/** 校验日期不为未来 */
function validateDateNotFuture(dateStr: string): void {
  const inputDate = new Date(dateStr);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (inputDate > today) {
    throw new BadRequestException('交易日期不能为未来日期');
  }
}

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculationService: CalculationService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /**
   * 校验组合归属当前用户
   * @throws NotFoundException 组合不存在或不属于当前用户
   */
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
   * 创建交易
   *
   * 副作用：若当日已有资产快照，触发当日净值+XIRR 计算
   */
  async create(
    userId: string,
    portfolioId: string,
    dto: CreateTransactionDto,
  ): Promise<TransactionResponse> {
    await this.verifyOwnership(userId, portfolioId);
    validateDateNotFuture(dto.date);

    // 首笔交易必须为买入
    const existingCount = await this.prisma.transaction.count({
      where: { portfolioId },
    });
    if (existingCount === 0 && dto.type !== TransactionType.BUY) {
      throw new BadRequestException('首笔交易必须为买入');
    }

    // SELL 金额不能超过截至该日的累计持仓成本（防止脏数据导致 XIRR 溢出）
    if (dto.type === TransactionType.SELL) {
      const cumResult = await this.prisma.transaction.findMany({
        where: { portfolioId, date: { lte: new Date(dto.date) } },
        select: { type: true, amount: true },
      });
      let holdings = 0;
      for (const t of cumResult) {
        holdings += t.type === 'BUY' ? Number(t.amount) : -Number(t.amount);
      }
      if (Number(dto.amount) > holdings) {
        throw new BadRequestException(
          `卖出金额 ${dto.amount} 超过截至该日的累计持仓成本 ${holdings.toFixed(2)}`,
        );
      }
    }

    const date = new Date(dto.date);
    const transaction = await this.prisma.transaction.create({
      data: {
        portfolioId,
        date,
        // shared 枚举与 Prisma 枚举值一致（'BUY'/'SELL'），运行时兼容
        type: dto.type as never,
        amount: dto.amount,
        note: dto.note,
      },
    });

    // 若当日有快照，触发当日计算
    const snapshot = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
      select: { id: true },
    });
    if (snapshot) {
      await this.calculationService.triggerCalculation(portfolioId, date);
    }

    return toResponse(transaction);
  }

  /**
   * 查询交易列表（分页 + 日期范围）
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: TransactionQuery,
  ): Promise<{ items: TransactionResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 20;
    const where = {
      portfolioId,
      ...(query.startDate || query.endDate
        ? {
            date: {
              ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
              ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 查询单笔交易
   */
  async findOne(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<TransactionResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const transaction = await this.prisma.transaction.findFirst({
      where: { id, portfolioId },
    });
    if (!transaction) {
      throw new NotFoundException('交易记录不存在');
    }
    return toResponse(transaction);
  }

  /**
   * 更新交易
   *
   * 副作用：从 min(原日期, 新日期) 起批量重算
   */
  async update(
    userId: string,
    portfolioId: string,
    id: string,
    dto: UpdateTransactionDto,
  ): Promise<TransactionResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.transaction.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('交易记录不存在');
    }

    if (dto.date) {
      validateDateNotFuture(dto.date);
    }

    const oldDate = existing.date;
    const newDate = dto.date ? new Date(dto.date) : oldDate;

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        ...(dto.date !== undefined && { date: newDate }),
        ...(dto.type !== undefined && { type: dto.type as never }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
    });

    // 从受影响日期起批量重算（取原日期和新日期的较小值）
    const affectedStart = oldDate <= newDate ? oldDate : newDate;
    await this.recalculationService.recalculateFromDate(portfolioId, affectedStart);

    return toResponse(updated);
  }

  /**
   * 删除交易
   *
   * 副作用：从原交易日期起批量重算
   */
  async remove(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<null> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.transaction.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('交易记录不存在');
    }

    await this.prisma.transaction.delete({ where: { id } });

    // 从原交易日期起批量重算
    await this.recalculationService.recalculateFromDate(portfolioId, existing.date);

    return null;
  }
}
