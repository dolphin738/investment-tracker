/**
 * SecurityPrice Service — 标的最新价 CRUD
 *
 * 方案B：SecurityPrice 按 asOf 日期向前沿用。
 * 同一标的可有多条价格记录（不同 asOf），查询时取 asOf ≤ 目标日期的最后一条。
 *
 * 🔴 写入后触发 recalculateRange
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { SecurityPrice as PrismaSecurityPrice } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../calculation/recalculation.service';
import type { UpsertSecurityPriceDto, SecurityPriceQueryDto } from './security-price.dto';

/** API 响应中的价格结构 */
export interface SecurityPriceResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  price: string;
  asOf: string;
  createdAt: string;
}

function toResponse(sp: PrismaSecurityPrice): SecurityPriceResponse {
  return {
    id: sp.id,
    portfolioId: sp.portfolioId,
    securityId: sp.securityId,
    price: sp.price.toString(),
    asOf: sp.asOf.toISOString().split('T')[0],
    createdAt: sp.createdAt.toISOString(),
  };
}

@Injectable()
export class SecurityPriceService {
  private readonly logger = new Logger(SecurityPriceService.name);

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
   * 录入/覆盖价格（upsert：同一 (portfolioId, securityId, asOf) 创建新记录）
   *
   * 🔴 写入后触发 recalculateRange
   */
  async upsert(
    userId: string,
    portfolioId: string,
    dto: UpsertSecurityPriceDto,
  ): Promise<SecurityPriceResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const asOf = new Date(dto.asOf);
    // 校验日期不为未来
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (asOf > today) {
      throw new BadRequestException('日期不能为未来日期');
    }

    // 验证标的属于该组合
    const security = await this.prisma.security.findFirst({
      where: { id: dto.securityId, portfolioId },
      select: { id: true },
    });
    if (!security) {
      throw new NotFoundException('标的不存在或不属于该组合');
    }

    // 删除同一 (securityId, asOf) 的旧价格，再创建新价格
    await this.prisma.securityPrice.deleteMany({
      where: {
        portfolioId,
        securityId: dto.securityId,
        asOf,
      },
    });

    const price = await this.prisma.securityPrice.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        price: dto.price,
        asOf,
      },
    });

    // 🔴 触发重算
    await this.recalculationService.recalculateRange(portfolioId, asOf);

    return toResponse(price);
  }

  /**
   * 查询价格列表（分页 + 日期范围 + 标的筛选）
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: SecurityPriceQueryDto,
  ): Promise<{ items: SecurityPriceResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { portfolioId };
    if (query.securityId) {
      where.securityId = query.securityId;
    }
    if (query.startDate || query.endDate) {
      where.asOf = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.securityPrice.findMany({
        where,
        orderBy: { asOf: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.securityPrice.count({ where }),
    ]);

    return { items: items.map(toResponse), total, page, pageSize };
  }

  /**
   * 删除价格记录
   *
   * 🔴 副作用：触发 recalculateRange
   */
  async remove(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<null> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.securityPrice.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('价格记录不存在');
    }

    const recalcDate = existing.asOf;
    await this.prisma.securityPrice.delete({ where: { id } });

    // 🔴 触发重算
    await this.recalculationService.recalculateRange(portfolioId, recalcDate);

    return null;
  }
}
