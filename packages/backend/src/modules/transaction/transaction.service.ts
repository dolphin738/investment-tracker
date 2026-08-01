/**
 * 交易管理服务
 *
 * 职责：
 * - 交易 CRUD（创建 / 查询列表 / 查询单个 / 更新 / 删除）
 * - 数据隔离：通过 verifyOwnership 校验组合归属
 * - 校验：金额 > 0、日期非未来、首笔必须买入
 * - 计算触发（均为级联重算）：
 *   - 创建交易 → 从该交易日期起批量重算（交易日无快照时，仍会重算其后有快照的日期）
 *   - 更新交易 → 从 min(原日期, 新日期) 起批量重算
 *   - 删除交易 → 从原交易日期起批量重算
 *
 * 🆕 T03 增强：
 *   - create/update 支持 securityId / quantity / price / fee 可选字段
 *   - findAll 支持 type / securityId 筛选
 *   - findOne 返回 securityName 关联数据
 *
 * 为什么创建也必须级联：净值逐日结转、XIRR 累计口径，任何一笔交易都会改变
 * 其后每一天的份额与现金流序列。补录一笔历史交易时，即使当天没有快照，
 * 其后所有有快照的日期也必须重算。
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Transaction as PrismaTransaction, Security } from '@prisma/client';
import { TransactionType, QueryGranularity } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../calculation/recalculation.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { DateRangeDto } from '../../common/dto/date-range.dto';

/**
 * Prisma 查询返回的 Transaction 实体（含可选的 Security 关联）
 */
type PrismaTransactionWithSecurity = PrismaTransaction & {
  security?: Pick<Security, 'name'> | null;
};

/** API 响应中的交易结构 */
export interface TransactionResponse {
  id: string;
  portfolioId: string;
  date: string;
  type: TransactionType;
  amount: string;
  /** 🆕 关联标的 ID */
  securityId: string | null;
  /** 🆕 标的名称（从 Security 关联查询） */
  securityName: string | null;
  /** 🆕 交易数量 */
  quantity: string | null;
  /** 🆕 成交单价 */
  price: string | null;
  /** 🆕 手续费 */
  fee: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应 */
function toResponse(t: PrismaTransactionWithSecurity): TransactionResponse {
  return {
    id: t.id,
    portfolioId: t.portfolioId,
    date: t.date.toISOString().split('T')[0],
    type: t.type,
    amount: t.amount.toString(),
    securityId: t.securityId ?? null,
    securityName: t.security?.name ?? null,
    quantity: t.quantity?.toString() ?? null,
    price: t.price?.toString() ?? null,
    fee: t.fee?.toString() ?? null,
    note: t.note,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** 交易列表查询参数 */
export interface TransactionQuery extends PaginationDto, DateRangeDto {
  /** 交易类型筛选（'BUY' | 'SELL'），可选 */
  type?: string;
  /** 标的 ID 筛选，可选 */
  securityId?: string;
}

/** 🆕 交易聚合结果 */
export interface TransactionAggregationPoint {
  /** 周期标识（如 "2025-03"） */
  period: string;
  /** 显示标签 */
  label: string;
  /** 买入总额 */
  buyAmount: string;
  /** 卖出总额 */
  sellAmount: string;
  /** 净现金流（sellAmount - buyAmount，正值为净流入） */
  netFlow: string;
  /** 交易笔数 */
  transactionCount: number;
}

/** 校验日期不为未来 */
function validateDateNotFuture(dateStr: string): void {
  const inputDate = new Date(dateStr);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (inputDate > today) {
    throw new BadRequestException('交易日期不能为未来日期');
  }
}

/** 🆕 日期格式化为 YYYY-MM-DD */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** 🆕 计算 ISO 8601 周号 */
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNum };
}

/** 🆕 根据粒度生成分组键和标签 */
function getGroupKey(date: Date, granularity: QueryGranularity): { key: string; label: string } {
  const dateStr = formatDate(date);
  switch (granularity) {
    case QueryGranularity.WEEK: {
      const { year, week } = getISOWeek(date);
      return { key: `${year}-W${String(week).padStart(2, '0')}`, label: `${year}-W${String(week).padStart(2, '0')}` };
    }
    case QueryGranularity.MONTH: {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      return { key: `${y}-${m}`, label: `${y}-${m}` };
    }
    case QueryGranularity.YEAR: {
      return { key: String(date.getUTCFullYear()), label: String(date.getUTCFullYear()) };
    }
    default:
      return { key: dateStr, label: dateStr };
  }
}

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
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
   * 🆕 支持可选字段：securityId / quantity / price / fee
   * 副作用：从该交易日期起级联重算净值+XIRR
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

    // 🆕 校验 securityId 若传入则必须存在且属于当前组合
    if (dto.securityId) {
      const security = await this.prisma.security.findFirst({
        where: { id: dto.securityId, portfolioId },
        select: { id: true },
      });
      if (!security) {
        throw new BadRequestException('标的不存在或不属于当前组合');
      }
    }

    const date = new Date(dto.date);
    const transaction = await this.prisma.transaction.create({
      data: {
        portfolioId,
        date,
        type: dto.type as never,
        amount: dto.amount,
        // 🆕 可选明细字段
        securityId: dto.securityId,
        quantity: dto.quantity,
        price: dto.price,
        fee: dto.fee,
        note: dto.note,
      },
      include: {
        security: { select: { name: true } },
      },
    });

    // 从该交易日期起级联重算
    await this.recalculationService.recalculateFromDate(portfolioId, date);

    return toResponse(transaction);
  }

  /**
   * 查询交易列表（分页 + 日期范围 + 类型 + 标的筛选）
   *
   * 🆕 新增 type / securityId 筛选参数
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: TransactionQuery,
  ): Promise<{ items: TransactionResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 20;

    // 构建 where 条件
    const where: Record<string, unknown> = {
      portfolioId,
    };

    // 日期范围筛选
    if (query.startDate || query.endDate) {
      where.date = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    // 🆕 交易类型筛选
    if (query.type) {
      where.type = query.type;
    }

    // 🆕 标的筛选
    if (query.securityId) {
      where.securityId = query.securityId;
    }

    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          security: { select: { name: true } },
        },
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
   *
   * 🆕 返回 securityName 关联数据
   */
  async findOne(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<TransactionResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const transaction = await this.prisma.transaction.findFirst({
      where: { id, portfolioId },
      include: {
        security: { select: { name: true } },
      },
    });
    if (!transaction) {
      throw new NotFoundException('交易记录不存在');
    }
    return toResponse(transaction);
  }

  /**
   * 更新交易
   *
   * 🆕 支持更新可选字段：securityId / quantity / price / fee（含设为 null）
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

    // 🆕 校验 securityId 若传入则必须存在且属于当前组合
    if (dto.securityId) {
      const security = await this.prisma.security.findFirst({
        where: { id: dto.securityId, portfolioId },
        select: { id: true },
      });
      if (!security) {
        throw new BadRequestException('标的不存在或不属于当前组合');
      }
    }

    const oldDate = existing.date;
    const newDate = dto.date ? new Date(dto.date) : oldDate;

    // 构建更新 data（使用 Prisma 的类型安全方式）
    const updateData: Record<string, unknown> = {};

    if (dto.date !== undefined) updateData.date = newDate;
    if (dto.type !== undefined) updateData.type = dto.type as never;
    if (dto.amount !== undefined) updateData.amount = dto.amount;

    // 🆕 可选明细字段（三态：undefined=不修改，null=清空，有值=更新）
    if (dto.securityId !== undefined) updateData.securityId = dto.securityId;
    if (dto.quantity !== undefined) updateData.quantity = dto.quantity;
    if (dto.price !== undefined) updateData.price = dto.price;
    if (dto.fee !== undefined) updateData.fee = dto.fee;
    if (dto.note !== undefined) updateData.note = dto.note;

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: updateData,
      include: {
        security: { select: { name: true } },
      },
    });

    // 从受影响日期起批量重算（取原日期和新日期的较小值）
    const affectedStart = oldDate <= newDate ? oldDate : newDate;
    await this.recalculationService.recalculateFromDate(portfolioId, affectedStart);

    return toResponse(updated);
  }

  /**
   * 🆕 交易多维聚合查询
   *
   * 按 日/周/月/年 粒度聚合交易数据，返回每个周期的：
   * - buyAmount：买入总额
   * - sellAmount：卖出总额
   * - netFlow：净现金流
   * - transactionCount：交易笔数
   */
  async findAggregated(
    userId: string,
    portfolioId: string,
    query: {
      granularity?: QueryGranularity;
      startDate?: string;
      endDate?: string;
      type?: TransactionType;
      securityId?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    items: TransactionAggregationPoint[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    await this.verifyOwnership(userId, portfolioId);

    const granularity = query.granularity || QueryGranularity.MONTH;
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 20;

    // 构建 where 条件
    const where: Record<string, unknown> = { portfolioId };

    if (query.startDate || query.endDate) {
      where.date = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    if (query.type) {
      where.type = query.type;
    }

    if (query.securityId) {
      where.securityId = query.securityId;
    }

    // 查询所有符合条件的交易
    const records = await this.prisma.transaction.findMany({
      where,
      orderBy: { date: 'asc' },
    });

    // 按粒度分组
    const groupMap = new Map<string, { key: string; label: string; items: typeof records }>();

    if (granularity === QueryGranularity.DAY) {
      for (const r of records) {
        const { key, label } = getGroupKey(r.date, granularity);
        groupMap.set(key, { key, label, items: [r] });
      }
    } else {
      for (const r of records) {
        const { key, label } = getGroupKey(r.date, granularity);
        const existing = groupMap.get(key);
        if (existing) {
          existing.items.push(r);
        } else {
          groupMap.set(key, { key, label, items: [r] });
        }
      }
    }

    // 按 key 排序
    const sortedGroups = Array.from(groupMap.values())
      .sort((a, b) => a.key.localeCompare(b.key));

    // 聚合每组数据
    const allItems: TransactionAggregationPoint[] = sortedGroups.map((group) => {
      let buyAmount = 0;
      let sellAmount = 0;

      for (const t of group.items) {
        const amt = Number(t.amount);
        if (t.type === 'BUY') {
          buyAmount += amt;
        } else {
          sellAmount += amt;
        }
      }

      return {
        period: group.key,
        label: group.label,
        buyAmount: buyAmount.toFixed(2),
        sellAmount: sellAmount.toFixed(2),
        netFlow: (sellAmount - buyAmount).toFixed(2),
        transactionCount: group.items.length,
      };
    });

    const total = allItems.length;
    const items = allItems.slice((page - 1) * pageSize, page * pageSize);

    return { items, total, page, pageSize };
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
