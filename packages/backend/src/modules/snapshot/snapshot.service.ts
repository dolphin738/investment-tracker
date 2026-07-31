/**
 * 资产快照服务
 *
 * 职责：
 * - 快照 upsert（每日唯一，重复则覆盖）
 * - 查询列表（分页 + 日期范围）
 * - 删除快照
 * - 计算触发：
 *   - upsert → 触发当日净值+XIRR 计算
 *   - 删除 → 从原快照日期起批量重算
 *
 * 快照是触发当日计算的前提（PRD §3.5）。
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AssetSnapshot as PrismaAssetSnapshot } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CalculationService } from '../calculation/calculation.service';
import { RecalculationService } from '../calculation/recalculation.service';
import { UpsertSnapshotDto } from './dto/upsert-snapshot.dto';
import { SnapshotQueryDto } from './dto/snapshot-query.dto';

/** API 响应中的快照结构 */
export interface SnapshotResponse {
  id: string;
  portfolioId: string;
  date: string;
  totalAsset: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应 */
function toResponse(s: PrismaAssetSnapshot): SnapshotResponse {
  return {
    id: s.id,
    portfolioId: s.portfolioId,
    date: s.date.toISOString().split('T')[0],
    totalAsset: s.totalAsset.toString(),
    note: s.note,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** 校验日期不为未来 */
function validateDateNotFuture(dateStr: string): void {
  const inputDate = new Date(dateStr);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (inputDate > today) {
    throw new BadRequestException('快照日期不能为未来日期');
  }
}

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculationService: CalculationService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /**
   * 校验组合归属当前用户
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
   * 录入/覆盖快照（upsert 语义：每日唯一，重复则覆盖）
   *
   * 副作用：触发当日净值+XIRR 计算
   */
  async upsert(
    userId: string,
    portfolioId: string,
    dto: UpsertSnapshotDto,
  ): Promise<SnapshotResponse> {
    await this.verifyOwnership(userId, portfolioId);
    validateDateNotFuture(dto.date);

    const date = new Date(dto.date);
    const snapshot = await this.prisma.assetSnapshot.upsert({
      where: { portfolioId_date: { portfolioId, date } },
      create: {
        portfolioId,
        date,
        totalAsset: dto.totalAsset,
        note: dto.note,
      },
      update: {
        totalAsset: dto.totalAsset,
        note: dto.note,
      },
    });

    // 触发当日净值+XIRR 计算
    await this.calculationService.triggerCalculation(portfolioId, date);

    return toResponse(snapshot);
  }

  /**
   * 查询快照列表（分页 + 日期范围）
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: SnapshotQueryDto,
  ): Promise<{ items: SnapshotResponse[]; total: number; page: number; pageSize: number }> {
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
      this.prisma.assetSnapshot.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.assetSnapshot.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 删除快照
   *
   * 副作用：从原快照日期起批量重算
   */
  async remove(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<null> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.assetSnapshot.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('资产快照不存在');
    }

    // 删除对应的净值和 XIRR 记录（因为无快照则不计算）
    await this.prisma.dailyNav.deleteMany({
      where: { portfolioId, date: existing.date },
    });
    await this.prisma.dailyXirr.deleteMany({
      where: { portfolioId, date: existing.date },
    });

    await this.prisma.assetSnapshot.delete({ where: { id } });

    // 从原快照日期起批量重算（更新后续日期的净值，因为份额依赖可能变化）
    await this.recalculationService.recalculateFromDate(portfolioId, existing.date);

    return null;
  }
}
