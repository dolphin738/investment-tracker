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
import { SnapshotSource } from '@investment-tracker/shared';
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
  /**
   * 该日**系统派生**的总资产（Decimal 字符串），用于「手工值 / 派生值 / 差异」对比
   * （AL-054 · 决策 Q-1 甲）。
   *
   * - `source === 'DERIVED'` → 等于 `totalAsset`（该行本就是系统算出来的，不重复计算）
   * - `source === 'MANUAL'`  → `AssetValuationService.computeDerivedBatch` 的实时结果
   * - 计算失败 / 数据缺失     → `null`（🔴 列表仍返回 200，绝不因此抛错）
   *
   * 🔴 运行时计算的响应字段，**不落库**（Prisma schema 零变更）。
   */
  derivedTotalAsset: string | null;
}

function toResponse(s: PrismaAssetSnapshot): SnapshotResponse {
  const source = s.source;
  const totalAsset = s.totalAsset.toString();
  return {
    id: s.id,
    portfolioId: s.portfolioId,
    date: s.date.toISOString().split('T')[0],
    totalAsset,
    marketValue: s.marketValue?.toString() ?? null,
    cashBalance: s.cashBalance?.toString() ?? null,
    source,
    valuationFlag: s.valuationFlag,
    note: s.note,
    recordedAt: s.recordedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    // DERIVED 行：派生值 === 落库值，直接复用，无需查库
    // MANUAL 行：先置 null，由 attachDerivedTotalAsset 批量回填
    derivedTotalAsset: source === SnapshotSource.DERIVED ? totalAsset : null,
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

    const rows = await this.attachDerivedTotalAsset(
      portfolioId,
      items.map(toResponse),
    );

    return { items: rows, total, page, pageSize };
  }

  /**
   * 查询指定日期单条快照（A3 · GET /snapshots/:date）
   *
   * 复用 {@link withDerivedTotalAsset} 回填派生值（与列表 / 录入 / 更新 / 重置
   * 同一实现，保证「列表看到的派生值」与「单条看到的」一致）。
   *
   * @param userId 用户 ID
   * @param portfolioId 组合 ID
   * @param dateStr 日期 YYYY-MM-DD（非该格式 → 400）
   * @returns 单条快照响应（含 derivedTotalAsset）
   * @throws BadRequestException 日期参数格式非法
   * @throws NotFoundException 该日无快照记录 / 组合无权访问
   */
  async findOne(
    userId: string,
    portfolioId: string,
    dateStr: string,
  ): Promise<SnapshotResponse> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException(`无效日期参数: ${dateStr}`);
    }
    await this.verifyOwnership(userId, portfolioId);

    const date = new Date(dateStr);
    const snapshot = await this.prisma.assetSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date } },
    });
    if (!snapshot) {
      throw new NotFoundException('资产快照不存在');
    }
    return this.withDerivedTotalAsset(portfolioId, toResponse(snapshot));
  }

  // ==========================================================
  // 派生总资产回填（AL-054 · 决策 Q-1 甲）
  // ==========================================================

  /**
   * 为 `source === 'MANUAL'` 的行回填 `derivedTotalAsset`
   *
   * 🔴 严禁 N+1：无论有多少条 MANUAL 行，**只调用一次**
   * `AssetValuationService.computeDerivedBatch`（内部固定 3 次查库）。
   * 逐条调 `computeDerived` 会退化成 3N 次查库，是本方法存在的唯一理由。
   *
   * 🔴 失败降级：派生计算是**增强信息**而非核心数据。任何异常
   * （数据缺失 / 交易回放校验失败 / 数据库抖动）一律吞掉并记 warn，
   * 相关行的 `derivedTotalAsset` 保持 `null`，列表照常返回 200。
   *
   * @param portfolioId 组合 ID
   * @param rows 已由 `toResponse` 转换的响应行（DERIVED 行已自带派生值）
   * @returns 原地回填后的同一批行（保持顺序）
   */
  private async attachDerivedTotalAsset(
    portfolioId: string,
    rows: SnapshotResponse[],
  ): Promise<SnapshotResponse[]> {
    const manualRows = rows.filter(
      (r) => r.source === SnapshotSource.MANUAL,
    );
    if (manualRows.length === 0) {
      // 全是 DERIVED 行 → 派生值已在 toResponse 里填好，零查询
      return rows;
    }

    try {
      const dates = manualRows.map(
        (r) => new Date(`${r.date}T00:00:00.000Z`),
      );
      const derivedMap = await this.assetValuation.computeDerivedBatch(
        portfolioId,
        dates,
      );

      for (const row of manualRows) {
        const derived = derivedMap.get(row.date);
        // 金额统一 2 位小数字符串（与 DECIMAL(18,2) 传输口径一致）
        row.derivedTotalAsset = derived ? derived.totalAsset.toFixed(2) : null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `派生总资产计算失败，相关行 derivedTotalAsset 降级为 null：portfolioId=${portfolioId} rows=${manualRows.length} reason=${message}`,
      );
      for (const row of manualRows) {
        row.derivedTotalAsset = null;
      }
    }

    return rows;
  }

  /**
   * 单条响应的派生总资产回填（upsert / update / reset 三个写入端点共用）
   *
   * 语义与 {@link attachDerivedTotalAsset} 完全一致（同一实现），
   * 保证「列表看到的派生值」与「保存后立刻返回的派生值」不会打架。
   *
   * @param portfolioId 组合 ID
   * @param row 单条响应行
   * @returns 回填后的同一行
   */
  private async withDerivedTotalAsset(
    portfolioId: string,
    row: SnapshotResponse,
  ): Promise<SnapshotResponse> {
    const [filled] = await this.attachDerivedTotalAsset(portfolioId, [row]);
    return filled;
  }

  // ==========================================================
  // 手工录入（source=MANUAL）
  // ==========================================================

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

    return this.withDerivedTotalAsset(portfolioId, toResponse(snapshot));
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

    // 🔴 T5 级联：日期变更时从新旧日期中较早的开始（覆盖影响范围）
    const recalcDate = dto.date
      ? new Date(Math.min(new Date(dto.date).getTime(), existing.date.getTime()))
      : existing.date;
    await this.recalculationService.recalculateNavRange(portfolioId, recalcDate);

    return this.withDerivedTotalAsset(portfolioId, toResponse(updated));
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

    return this.withDerivedTotalAsset(portfolioId, toResponse(snapshot));
  }
}
