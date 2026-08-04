/**
 * 资产快照服务（方案B）
 *
 * 职责：
 * - 手工录入快照（source=MANUAL）
 * - 按日期范围查询分页列表
 * - 更新手工记录
 * - 删除记录（若为事件日则回填 DERIVED）
 * - 重置为 DERIVED（upsert 覆盖）
 *
 * 🔴 T5 级联：手工三路径（upsert/delete/reset）在同一事务内调用 recalculateNavRange
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AssetSnapshot as PrismaAssetSnapshot, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../recalculation/recalculation.service';
import { AssetValuationService } from '../valuation/asset-valuation.service';
import type { UpsertSnapshotDto, SnapshotQueryDto } from './dto/upsert-snapshot.dto';

/** API 响应中的快照结构（方案B） */
export interface SnapshotResponse {
  id: string;
  portfolioId: string;
  date: string;
  totalAsset: string;
  marketValue: string | null;
  cashBalance: string | null;
  source: string;
  valuationFlag: string;
  note: string | null;
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
}

function toResponse(s: PrismaAssetSnapshot): SnapshotResponse {
  return {
    id: s.id,
    portfolioId: s.portfolioId,
    date: s.date.toISOString().split('T')[0],
    totalAsset: s.totalAsset.toString(),
    marketValue: s.marketValue?.toString() ?? null,
    cashBalance: s.cashBalance?.toString() ?? null,
    source: s.source,
    valuationFlag: s.valuationFlag,
    note: s.note,
    recordedAt: s.recordedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recalculationService: RecalculationService,
    private readonly assetValuation: AssetValuationService,
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

  private validateDateNotFuture(dateStr: string): void {
    const inputDate = new Date(dateStr);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (inputDate > today) {
      throw new BadRequestException('快照日期不能为未来日期');
    }
  }

  // ==========================================================
  // 查询
  // ==========================================================

  /**
   * 按日期范围分页查询快照
   */
  async findAll(
    userId: string,
    portfolioId: string,
    query: SnapshotQueryDto,
  ): Promise<{ items: SnapshotResponse[]; total: number; page: number; pageSize: number }> {
    await this.verifyOwnership(userId, portfolioId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.AssetSnapshotWhereInput = {
      portfolioId,
      ...(query.startDate || query.endDate
        ? {
            date: {
              ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
              ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
            },
          }
        : {}),
      // 来源筛选：前端不传则为 undefined，不筛选
      ...(query.source ? { source: query.source } : {}),
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

    return { items: items.map(toResponse), total, page, pageSize };
  }

  // ==========================================================
  // 手工录入（source=MANUAL）
  // ==========================================================

  /**
   * 向后兼容别名：upsert → upsertManual（source=MANUAL）
   *
   * 供 HoldingService 等 Plan A 模块过渡使用。
   */
  async upsert(
    userId: string,
    portfolioId: string,
    dto: UpsertSnapshotDto,
  ): Promise<SnapshotResponse> {
    return this.upsertManual(userId, portfolioId, dto);
  }

  /**
   * 手工录入快照（upsert 语义，source 固定为 MANUAL）
   *
   * 🔴 T5 级联：写入后调用 recalculateNavRange
   */
  async upsertManual(
    userId: string,
    portfolioId: string,
    dto: UpsertSnapshotDto,
  ): Promise<SnapshotResponse> {
    await this.verifyOwnership(userId, portfolioId);
    this.validateDateNotFuture(dto.date);

    const date = new Date(dto.date);

    const snapshot = await this.prisma.assetSnapshot.upsert({
      where: { portfolioId_date: { portfolioId, date } },
      create: {
        portfolioId,
        date,
        totalAsset: dto.totalAsset,
        marketValue: dto.marketValue,
        cashBalance: dto.cashBalance,
        source: 'MANUAL',
        valuationFlag: dto.valuationFlag ?? 'MANUAL_INPUT',
        note: dto.note,
        recordedAt: new Date(),
      },
      update: {
        totalAsset: dto.totalAsset,
        marketValue: dto.marketValue ?? null,
        cashBalance: dto.cashBalance ?? null,
        source: 'MANUAL',
        valuationFlag: dto.valuationFlag ?? 'MANUAL_INPUT',
        note: dto.note ?? null,
        recordedAt: new Date(),
      },
    });

    // 🔴 T5 级联
    await this.recalculationService.recalculateNavRange(portfolioId, date);

    return toResponse(snapshot);
  }

  // ==========================================================
  // 更新手工记录
  // ==========================================================

  /**
   * 更新手工快照（仅限 source=MANUAL）
   *
   * 🔴 T5 级联：更新后调用 recalculateNavRange
   */
  async update(
    userId: string,
    portfolioId: string,
    id: string,
    dto: UpsertSnapshotDto,
  ): Promise<SnapshotResponse> {
    await this.verifyOwnership(userId, portfolioId);

    const existing = await this.prisma.assetSnapshot.findFirst({
      where: { id, portfolioId },
    });
    if (!existing) {
      throw new NotFoundException('资产快照不存在');
    }
    if (existing.source !== 'MANUAL') {
      throw new BadRequestException('只能修改手工录入的快照');
    }

    if (dto.date) {
      this.validateDateNotFuture(dto.date);
    }

    const updated = await this.prisma.assetSnapshot.update({
      where: { id },
      data: {
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(dto.totalAsset !== undefined && { totalAsset: dto.totalAsset }),
        ...(dto.marketValue !== undefined && { marketValue: dto.marketValue }),
        ...(dto.cashBalance !== undefined && { cashBalance: dto.cashBalance }),
        ...(dto.valuationFlag !== undefined && { valuationFlag: dto.valuationFlag }),
        ...(dto.note !== undefined && { note: dto.note }),
        recordedAt: new Date(),
      },
    });

    // 🔴 T5 级联
    const recalcDate = dto.date ? new Date(dto.date) : existing.date;
    await this.recalculationService.recalculateNavRange(portfolioId, recalcDate);

    return toResponse(updated);
  }

  // ==========================================================
  // 删除 / 重置
  // ==========================================================

  /**
   * 删除快照记录
   *
   * - 若为 source=MANUAL：直接删除，然后回填 DERIVED
   * - 若为 source=DERIVED：直接删除
   *
   * 🔴 委托 AssetValuationService.deleteRecord（内部 isEventDate + persistDerived
   *    正确回填 DERIVED，替代旧的 totalAsset=0 占位逻辑）
   * 🔴 T5 级联：删除后调用 recalculateNavRange
   */
  async deleteRecord(
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

    // 委托删除：物理删除 + 事件日回填 DERIVED（persistDerived 内部 computeDerived）
    await this.assetValuation.deleteRecord(portfolioId, existing.date);

    // 🔴 T5 级联
    await this.recalculationService.recalculateNavRange(portfolioId, existing.date);

    return null;
  }

  /**
   * 重置为 DERIVED：将指定日期快照覆盖为 DERIVED 来源，恢复系统计算值
   *
   * 🔴 委托 AssetValuationService.resetToDerived（内部 computeDerived → upsert
   *    原地覆盖，恢复系统计算值，替代旧「只改 source 标记」逻辑）
   * 🔴 T5 级联：写入后调用 recalculateNavRange
   */
  async resetToDerived(
    userId: string,
    portfolioId: string,
    dateStr: string,
  ): Promise<SnapshotResponse> {
    await this.verifyOwnership(userId, portfolioId);
    this.validateDateNotFuture(dateStr);

    const date = new Date(dateStr);

    // 委托重置：computeDerived(date) → upsert 覆盖，source 置回 DERIVED
    await this.assetValuation.resetToDerived(portfolioId, date);

    // 读取重置后的行，保持响应结构与改前一致
    const snapshot = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
    });
    if (!snapshot) {
      throw new NotFoundException('资产快照不存在');
    }

    // 🔴 T5 级联
    await this.recalculationService.recalculateNavRange(portfolioId, date);

    return toResponse(snapshot);
  }
}
