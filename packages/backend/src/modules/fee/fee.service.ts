/**
 * 费用记录服务（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复 + 增量 I-03）
 *
 * 职责：
 * - 费用记录 CRUD（create / findAll / update / remove）
 * - 数据隔离：所有读写先校验 portfolio.userId === 当前用户（与 CashFlowService 同范式）
 * - 二级隔离：securityId 必须属于同一组合，杜绝跨组合挂载标的
 * - 场景推断（I-03）：create 时 scenario = dto.scenario ?? (transactionId → SecurityTrade.side) ?? BUY
 * - 合并展示（I-03 / Q-8）：findAll(grouped=1) 按合并键
 *   (portfolioId, securityId, date, scenario, type) 应用层聚合返回合计行（FeeGroupedRow），
 *   底层明细行不物理合并，transactionId 保留精确关联（编辑/删除组成笔即重算）
 *
 * ⚠️ 约束（C-09 / D-03）：
 * - 不进 CashFlow 表（不参与 XIRR 现金流，C-02）
 * - 不触发计算引擎（不注入 RecalculationService / CalculationModule）
 * - 与 SecurityTrade.fee（计入持仓成本）互不影响，本表仅信息记录
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, FeeType, FeeScenario, SecuritySide } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateFeeRecordDto } from './dto/create-fee-record.dto';
import type { UpdateFeeRecordDto } from './dto/update-fee-record.dto';

/** 费用记录响应（金额以字符串传输，保持 NUMERIC(18,2) 精度；scenario 为 I-03 新增） */
export interface FeeRecordResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  amount: string;
  type: FeeType;
  /** 费用场景：BUY 买入时 / SELL 卖出时（I-03） */
  scenario: FeeScenario;
  transactionId: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * 费用列表 grouped=1 聚合行（I-03 / Q-3 语义：明细行各自保留 transactionId，
 * 聚合行携带 transactionIds[] 全量去重，无需「保留某一笔」）
 */
export interface FeeGroupedRow {
  /** `${securityId}|${date}|${scenario}|${type}` */
  mergeKey: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  /** YYYY-MM-DD */
  date: string;
  scenario: FeeScenario;
  type: FeeType;
  /** Σ 金额，toFixed(2) */
  amount: string;
  /** 组成笔数 */
  count: number;
  /** 关联流水 ID 去重列表 */
  transactionIds: string[];
}

/** findAll 过滤选项（I-05 统一筛选器 / I-03 grouped） */
export interface FeeQueryOptions {
  /** 单值标的（兼容旧调用；逗号分隔时按多值处理） */
  securityId?: string;
  /** 标的 ID 列表（多值；与 securityId 二选一，优先于 securityId） */
  securityIds?: string[];
  /** 场景过滤（I-05） */
  scenario?: FeeScenario;
  /** 起始日期 YYYY-MM-DD（含） */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD（含） */
  endDate?: string;
  /** grouped=1 按合并键聚合返回 FeeGroupedRow[]；缺省返回明细行 */
  grouped?: boolean;
}

/** Prisma 查询时统一带出的标的字段 */
const SECURITY_SELECT = { select: { name: true, code: true } } as const;

/** 带 security 关联的 Prisma FeeRecord 行（toResponse / 聚合共用） */
type FeeRecordWithSecurity = {
  id: string;
  portfolioId: string;
  securityId: string;
  date: Date;
  amount: Prisma.Decimal;
  type: FeeType;
  scenario: FeeScenario;
  transactionId: string | null;
  note: string | null;
  createdAt: Date;
  security: { name: string; code: string };
};

@Injectable()
export class FeeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 校验组合归属权（user_id 数据隔离第一道闸）
   *
   * @throws NotFoundException 组合不存在或不属于当前用户（不泄露存在性）
   */
  private async validatePortfolioOwnership(
    portfolioId: string,
    userId: string,
  ): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  /**
   * 校验标的归属于该组合（第二道闸：防跨组合挂载）
   *
   * @throws NotFoundException 标的不存在或不属于该组合
   */
  private async validateSecurityInPortfolio(
    portfolioId: string,
    securityId: string,
  ): Promise<void> {
    const security = await this.prisma.security.findFirst({
      where: { id: securityId, portfolioId },
      select: { id: true },
    });
    if (!security) {
      throw new NotFoundException('标的不存在或不属于该组合');
    }
  }

  /**
   * 解析并校验金额：必须 > 0（PRD HOLD-B-P0-10）
   *
   * @throws BadRequestException 金额非法或 ≤ 0
   */
  private parseAmount(raw: string): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException('费用金额格式非法');
    }
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('费用金额必须大于 0');
    }
    return amount;
  }

  /**
   * 按 transactionId 推断费用场景（I-03 辅助推断）：
   * SecurityTrade.side === 'BUY_SEC' → BUY；'SELL_SEC' → SELL；
   * 流水不存在 / 已删 / 不属于该组合 → null（回退默认 BUY，不抛错）
   */
  private async inferScenarioFromTradeId(
    portfolioId: string,
    transactionId: string,
  ): Promise<FeeScenario | null> {
    const trade = await this.prisma.securityTrade.findFirst({
      where: { id: transactionId, portfolioId },
      select: { side: true },
    });
    if (!trade) return null;
    return trade.side === SecuritySide.BUY_SEC
      ? FeeScenario.BUY
      : FeeScenario.SELL;
  }

  /** Prisma 记录 → 响应 DTO */
  private toResponse(record: FeeRecordWithSecurity): FeeRecordResponse {
    return {
      id: record.id,
      portfolioId: record.portfolioId,
      securityId: record.securityId,
      securityName: record.security.name,
      securityCode: record.security.code,
      date: record.date.toISOString().split('T')[0],
      amount: record.amount.toString(),
      type: record.type,
      scenario: record.scenario,
      transactionId: record.transactionId,
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    };
  }

  /**
   * 按合并键 (securityId, date, scenario, type) 应用层聚合（I-03 / Q-8 展示层聚合）。
   *
   * 先过滤后聚合，避免多余行；聚合键不含 portfolioId（同一次 findAll 已限定单组合）。
   * 排序：date desc → scenario → type → securityCode asc（稳定）。
   */
  private groupByMergeKey(records: FeeRecordWithSecurity[]): FeeGroupedRow[] {
    const map = new Map<string, FeeGroupedRow>();
    for (const r of records) {
      const date = r.date.toISOString().split('T')[0];
      const key = `${r.securityId}|${date}|${r.scenario}|${r.type}`;
      const existing = map.get(key);
      if (existing) {
        existing.amount = new Prisma.Decimal(existing.amount)
          .plus(r.amount)
          .toFixed(2);
        existing.count += 1;
        if (r.transactionId && !existing.transactionIds.includes(r.transactionId)) {
          existing.transactionIds.push(r.transactionId);
        }
      } else {
        map.set(key, {
          mergeKey: key,
          securityId: r.securityId,
          securityName: r.security.name,
          securityCode: r.security.code,
          date,
          scenario: r.scenario,
          type: r.type,
          amount: r.amount.toFixed(2),
          count: 1,
          transactionIds: r.transactionId ? [r.transactionId] : [],
        });
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.scenario.localeCompare(b.scenario) ||
        a.type.localeCompare(b.type) ||
        a.securityCode.localeCompare(b.securityCode),
    );
  }

  /**
   * 新增费用记录
   *
   * 场景推断（I-03）：dto.scenario ?? (transactionId → SecurityTrade.side) ?? BUY。
   *
   * @param portfolioId 组合 ID
   * @param userId 当前用户 ID（数据隔离）
   * @param dto 创建入参
   */
  async create(
    portfolioId: string,
    userId: string,
    dto: CreateFeeRecordDto,
  ): Promise<FeeRecordResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);
    await this.validateSecurityInPortfolio(portfolioId, dto.securityId);

    const amount = this.parseAmount(dto.amount);
    const scenario =
      dto.scenario ??
      (dto.transactionId
        ? await this.inferScenarioFromTradeId(portfolioId, dto.transactionId)
        : null) ??
      FeeScenario.BUY;

    const record = await this.prisma.feeRecord.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        date: new Date(dto.date),
        amount,
        type: dto.type ?? FeeType.OTHER,
        scenario,
        transactionId: dto.transactionId ?? null,
        note: dto.note ?? null,
      },
      include: { security: SECURITY_SELECT },
    });

    return this.toResponse(record);
  }

  /**
   * 查询费用记录列表（按日期倒序）
   *
   * - 第三个参数兼容两种形态：旧调用传 `string`（单值 securityId）或新调用传 `FeeQueryOptions`。
   * - grouped=true 时按合并键聚合返回 `FeeGroupedRow[]`；否则返回明细行 `FeeRecordResponse[]`。
   *
   * @param portfolioId 组合 ID
   * @param userId 当前用户 ID（数据隔离）
   * @param query 过滤选项（可选）
   */
  async findAll(
    portfolioId: string,
    userId: string,
    query?: string | FeeQueryOptions,
  ): Promise<FeeRecordResponse[] | FeeGroupedRow[]> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const opts: FeeQueryOptions =
      typeof query === 'string' ? { securityId: query } : (query ?? {});

    const where: Prisma.FeeRecordWhereInput = { portfolioId };
    const securityIds =
      opts.securityIds ??
      (opts.securityId
        ? opts.securityId.split(',').filter((s) => s.length > 0)
        : []);
    // 单值直接等值（向后兼容旧调用）；多值才用 { in: [...] }
    if (securityIds.length === 1) {
      where.securityId = securityIds[0];
    } else if (securityIds.length > 1) {
      where.securityId = { in: securityIds };
    }
    if (opts.scenario) {
      where.scenario = opts.scenario;
    }
    if (opts.startDate || opts.endDate) {
      where.date = {
        ...(opts.startDate ? { gte: new Date(opts.startDate) } : {}),
        ...(opts.endDate ? { lte: new Date(opts.endDate) } : {}),
      };
    }

    const records = await this.prisma.feeRecord.findMany({
      where,
      include: { security: SECURITY_SELECT },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    if (opts.grouped) {
      return this.groupByMergeKey(records);
    }
    return records.map((record) => this.toResponse(record));
  }

  /**
   * 更新费用记录（增量 I-03 · 新增 PATCH /fees/:id）
   *
   * 可改字段：securityId / date / amount / type / scenario / note；全部可选。
   * - 双闸：portfolio.userId 404 + security 归属 404（K-7 同范式）
   * - scenario 可修正（迁移后默认 BUY 的存量记录可在 UI 手动改为 SELL）
   * - 合并展示层自动重聚合：scenario/date/securityId/type 任一变化即脱离原合并键
   *
   * @param portfolioId 组合 ID
   * @param id 费用记录 ID
   * @param userId 当前用户 ID（数据隔离）
   * @param dto 更新入参（全可选）
   */
  async update(
    portfolioId: string,
    id: string,
    userId: string,
    dto: UpdateFeeRecordDto,
  ): Promise<FeeRecordResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const existing = await this.prisma.feeRecord.findFirst({
      where: { id, portfolioId },
      include: { security: SECURITY_SELECT },
    });
    if (!existing) {
      throw new NotFoundException('费用记录不存在');
    }

    // 标的变更走双闸（防跨组合挂载）
    if (dto.securityId !== undefined) {
      await this.validateSecurityInPortfolio(portfolioId, dto.securityId);
    }

    const nextAmount =
      dto.amount !== undefined ? this.parseAmount(dto.amount) : undefined;

    const record = await this.prisma.feeRecord.update({
      where: { id },
      data: {
        ...(dto.securityId !== undefined && { securityId: dto.securityId }),
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(nextAmount !== undefined && { amount: nextAmount }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.scenario !== undefined && { scenario: dto.scenario }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
      include: { security: SECURITY_SELECT },
    });

    return this.toResponse(record);
  }

  /**
   * 删除费用记录
   *
   * @param portfolioId 组合 ID
   * @param id 费用记录 ID
   * @param userId 当前用户 ID（数据隔离）
   */
  async remove(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<null> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const record = await this.prisma.feeRecord.findFirst({
      where: { id, portfolioId },
      select: { id: true },
    });
    if (!record) {
      throw new NotFoundException('费用记录不存在');
    }

    await this.prisma.feeRecord.delete({ where: { id } });
    return null;
  }
}
