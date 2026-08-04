/**
 * CashFlow Service — 出入金流水 CRUD
 *
 * 方案B：出入金是 XIRR 现金流唯一来源。
 * 所有查询以 portfolioId + userId 双重过滤实现数据隔离。
 *
 * 🔴 写入/编辑/删除后触发 RecalculationService.recalculateRange(portfolioId, date)
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CashFlow as PrismaCashFlow } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../recalculation/recalculation.service';
import type { CreateCashFlowDto, UpdateCashFlowDto, CashFlowQueryDto } from './cashflow.dto';

/** API 响应中的出入金流水结构 */
export interface CashFlowResponse {
  id: string;
  portfolioId: string;
  date: string;
  type: string;
  amount: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 重算反馈元信息（F3/F4：create/update/remove 透出 recalculateRange 结果）。
 *
 * 字段命名对齐设计文档 Part E-6：
 * - fromDate: 重算起始日（YYYY-MM-DD）
 * - affectedDays: 受影响天数（= recalculateRange.recalculatedDays）
 * - skippedManualDays: 被跳过的手工记录天数（F4）
 */
export interface RecalculationMeta {
  fromDate: string;
  affectedDays: number;
  skippedManualDays: number;
}

/** create/update 响应 = 既有 CashFlowResponse + 重算反馈（新增字段，向后兼容） */
export type CashFlowMutationResponse = CashFlowResponse & {
  recalculation: RecalculationMeta;
};

/** 将 Prisma 实体转为 API 响应（Decimal → string, Date → string） */
function toResponse(cf: PrismaCashFlow): CashFlowResponse {
  return {
    id: cf.id,
    portfolioId: cf.portfolioId,
    date: cf.date.toISOString().split('T')[0],
    type: cf.type,
    amount: cf.amount.toString(),
    note: cf.note,
    createdAt: cf.createdAt.toISOString(),
    updatedAt: cf.updatedAt.toISOString(),
  };
}

/** recalculateRange 返回结构（F4 扩展后） */
interface RecalculateRangeResult {
  recalculatedDays: number;
  fromDate: string;
  toDate: string;
  skippedManualDays: number;
}

@Injectable()
export class CashFlowService {
  private readonly logger = new Logger(CashFlowService.name);

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

  /** 把 recalculateRange 结果映射为响应中的 recalculation 字段（F3/F4） */
  private toRecalculationMeta(result: RecalculateRangeResult): RecalculationMeta {
    return {
      fromDate: result.fromDate,
      affectedDays: result.recalculatedDays,
      skippedManualDays: result.skippedManualDays,
    };
  }

  /**
   * 创建出入金流水
   *
   * 🔴 副作用：触发 recalculateRange，结果透出到响应 recalculation 字段（F3/F4）
   */
  async create(
    userId: string,
    portfolioId: string,
    dto: CreateCashFlowDto,
  ): Promise<CashFlowMutationResponse> {
    await this.verifyOwnership(userId, portfolioId);
    this.validateDateNotFuture(dto.date);

    const date = new Date(dto.date);
    const cashflow = await this.prisma.cashFlow.create({
      data: {
        portfolioId,
        date,
        type: dto.type,
        amount: dto.amount,
        note: dto.note,
      },
    });

    // 🔴 触发重算
    const recalcResult = await this.recalculationService.recalculateRange(
      portfolioId,
      date,
    );

    return {
      ...toResponse(cashflow),
      recalculation: this.toRecalculationMeta(recalcResult),
    };
  }

  /**
   * 查询出入金流水列表（分页 + 日期范围）
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: CashFlowQueryDto,
  ): Promise<{ items: CashFlowResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const sortBy = query.sortBy ?? 'date';
    const sortOrder = query.sortOrder ?? 'desc';

    // F2：类型多选优先（非空数组），否则回退单值 type（向后兼容）；
    // 空数组 / 未传 = 全部
    const typeFilter =
      query.types && query.types.length > 0
        ? { type: { in: query.types } }
        : query.type
          ? { type: query.type }
          : {};

    const where = {
      portfolioId,
      ...typeFilter,
      ...(query.startDate || query.endDate
        ? {
            date: {
              ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
              ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
            },
          }
        : {}),
    };

    // F5：排序字段白名单（DTO 已用 @IsIn 严格校验 date/amount + asc/desc），
    // 默认 date desc（与既有硬编码行为一致）
    const orderBy = sortBy === 'amount' ? { amount: sortOrder } : { date: sortOrder };

    const [items, total] = await Promise.all([
      this.prisma.cashFlow.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cashFlow.count({ where }),
    ]);

    return { items: items.map(toResponse), total, page, pageSize };
  }

  /**
   * 获取单条出入金流水
   */
  async findOne(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<CashFlowResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const cashflow = await this.prisma.cashFlow.findFirst({
      where: { id, portfolioId },
    });
    if (!cashflow) {
      throw new NotFoundException('出入金记录不存在');
    }
    return toResponse(cashflow);
  }

  /**
   * 更新出入金流水
   *
   * 🔴 副作用：触发 recalculateRange（新旧两个日期），结果透出到响应 recalculation 字段（F3/F4）
   */
  async update(
    userId: string,
    portfolioId: string,
    id: string,
    dto: UpdateCashFlowDto,
  ): Promise<CashFlowMutationResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.cashFlow.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('出入金记录不存在');
    }

    if (dto.date) {
      this.validateDateNotFuture(dto.date);
    }

    const updated = await this.prisma.cashFlow.update({
      where: { id },
      data: {
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
    });

    // 🔴 触发重算：从较早的日期开始（覆盖新旧两个日期的影响范围）
    const recalcDate = dto.date ? new Date(Math.min(
      new Date(dto.date).getTime(),
      existing.date.getTime(),
    )) : existing.date;
    const recalcResult = await this.recalculationService.recalculateRange(
      portfolioId,
      recalcDate,
    );

    return {
      ...toResponse(updated),
      recalculation: this.toRecalculationMeta(recalcResult),
    };
  }

  /**
   * 删除出入金流水
   *
   * 🔴 副作用：触发 recalculateRange，结果透出到响应 recalculation 字段（F3/F4）。
   * 响应由 null 变为 { recalculation }（设计文档 Part E-6 / F3 约定）。
   */
  async remove(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<{ recalculation: RecalculationMeta }> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.cashFlow.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('出入金记录不存在');
    }

    const recalcDate = existing.date;
    await this.prisma.cashFlow.delete({ where: { id } });

    // 🔴 触发重算
    const recalcResult = await this.recalculationService.recalculateRange(
      portfolioId,
      recalcDate,
    );

    return {
      recalculation: this.toRecalculationMeta(recalcResult),
    };
  }
}
