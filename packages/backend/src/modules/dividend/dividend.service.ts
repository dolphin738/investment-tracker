/**
 * 分红记录服务（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复 + 增量设计 R-2/R-5）
 *
 * 职责：
 * - 分红记录 CRUD（create / findAll / update / remove）
 * - 数据隔离：所有读写先校验 portfolio.userId === 当前用户（与 CashFlowService 同范式）
 * - 二级隔离：securityId 必须属于同一组合，杜绝跨组合挂载标的
 * - 净额口径（K-1/K-2）：netAmount = amount − tax，恒 ≥ 0；tax 缺省 0（存量兼容）
 *
 * ⚠️ 约束（C-08 / D-02）：
 * - 不进 CashFlow 表（不参与 XIRR 现金流，C-02）
 * - 不触发计算引擎（不注入 RecalculationService / CalculationModule）
 * - 不污染 daily_nav / daily_xirr
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, DividendType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateDividendRecordDto } from './dto/create-dividend-record.dto';
import type { UpdateDividendRecordDto } from './dto/update-dividend-record.dto';

/** 分红记录响应（金额以字符串传输，保持 NUMERIC(18,2) 精度；tax/netAmount 恒 2 位小数） */
export interface DividendRecordResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  /** 税前金额 */
  amount: string;
  /** 所得税 */
  tax: string;
  /** 净额 = amount − tax（后端统一计算，前端不自行二次计算 K-2） */
  netAmount: string;
  type: DividendType;
  note: string | null;
  createdAt: string;
}

/** Prisma 查询时统一带出的标的字段 */
const SECURITY_SELECT = { select: { name: true, code: true } } as const;

@Injectable()
export class DividendService {
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
   * 解析并校验税前金额：必须 > 0（PRD HOLD-B-P0-10）
   *
   * @throws BadRequestException 金额非法或 ≤ 0
   */
  private parseAmount(raw: string): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException('分红金额格式非法');
    }
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('分红金额必须大于 0');
    }
    return amount;
  }

  /**
   * 解析并校验所得税：必须 ≥ 0（净额口径 K-1）
   *
   * @throws BadRequestException 所得税非法或 < 0
   */
  private parseTax(raw?: string): Prisma.Decimal {
    if (raw === undefined || raw === null || raw === '') {
      return new Prisma.Decimal(0);
    }
    let tax: Prisma.Decimal;
    try {
      tax = new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException('所得税格式非法');
    }
    if (!tax.isFinite() || tax.lessThan(0)) {
      throw new BadRequestException('所得税不能为负');
    }
    return tax;
  }

  /**
   * 校验净额 = amount − tax ≥ 0（前后端同口径，防绕过前端）
   *
   * @throws BadRequestException 净额为负
   */
  private validateNetAmount(amount: Prisma.Decimal, tax: Prisma.Decimal): void {
    if (amount.minus(tax).lessThan(0)) {
      throw new BadRequestException('净额不能为负');
    }
  }

  /** Prisma 记录 → 响应 DTO（amount/tax/netAmount 统一 toFixed(2) 字符串） */
  private toResponse(record: {
    id: string;
    portfolioId: string;
    securityId: string;
    date: Date;
    amount: Prisma.Decimal;
    tax?: Prisma.Decimal | null;
    type: DividendType;
    note: string | null;
    createdAt: Date;
    security: { name: string; code: string };
  }): DividendRecordResponse {
    const amount = record.amount;
    // 存量数据（迁移前）可能无 tax，防御回退 0（Q-1）
    const tax = record.tax ?? new Prisma.Decimal(0);
    const netAmount = amount.minus(tax);
    return {
      id: record.id,
      portfolioId: record.portfolioId,
      securityId: record.securityId,
      securityName: record.security.name,
      securityCode: record.security.code,
      date: record.date.toISOString().split('T')[0],
      amount: amount.toFixed(2),
      tax: tax.toFixed(2),
      netAmount: netAmount.toFixed(2),
      type: record.type,
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    };
  }

  /**
   * 新增分红记录
   *
   * @param portfolioId 组合 ID
   * @param userId 当前用户 ID（数据隔离）
   * @param dto 创建入参
   */
  async create(
    portfolioId: string,
    userId: string,
    dto: CreateDividendRecordDto,
  ): Promise<DividendRecordResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);
    await this.validateSecurityInPortfolio(portfolioId, dto.securityId);

    const amount = this.parseAmount(dto.amount);
    const tax = this.parseTax(dto.tax);
    this.validateNetAmount(amount, tax);

    const record = await this.prisma.dividendRecord.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        date: new Date(dto.date),
        amount,
        tax,
        type: dto.type ?? DividendType.CASH,
        note: dto.note ?? null,
      },
      include: { security: SECURITY_SELECT },
    });

    return this.toResponse(record);
  }

  /**
   * 查询分红记录列表（按日期倒序）
   *
   * @param portfolioId 组合 ID
   * @param userId 当前用户 ID（数据隔离）
   * @param securityId 可选：按标的过滤
   */
  async findAll(
    portfolioId: string,
    userId: string,
    securityId?: string,
  ): Promise<DividendRecordResponse[]> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const where: Prisma.DividendRecordWhereInput = { portfolioId };
    if (securityId) {
      where.securityId = securityId;
    }

    const records = await this.prisma.dividendRecord.findMany({
      where,
      include: { security: SECURITY_SELECT },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    return records.map((record) => this.toResponse(record));
  }

  /**
   * 更新分红记录（增量设计 R-5 / C-3）
   *
   * 可改字段：securityId / date / amount / tax / note；全部可选。
   * - 双闸：portfolio.userId 404 + security 归属 404（K-7 同范式）
   * - 净额校验：resolve 当前值后 amount − tax ≥ 0，否则 400
   *
   * @param portfolioId 组合 ID
   * @param id 分红记录 ID
   * @param userId 当前用户 ID（数据隔离）
   * @param dto 更新入参（全可选）
   */
  async update(
    portfolioId: string,
    id: string,
    userId: string,
    dto: UpdateDividendRecordDto,
  ): Promise<DividendRecordResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const existing = await this.prisma.dividendRecord.findFirst({
      where: { id, portfolioId },
      include: { security: SECURITY_SELECT },
    });
    if (!existing) {
      throw new NotFoundException('分红记录不存在');
    }

    // 标的变更走双闸（防跨组合挂载）
    if (dto.securityId !== undefined) {
      await this.validateSecurityInPortfolio(portfolioId, dto.securityId);
    }

    const nextAmount =
      dto.amount !== undefined ? this.parseAmount(dto.amount) : undefined;
    const nextTax =
      dto.tax !== undefined ? this.parseTax(dto.tax) : undefined;

    // 净额校验：以「更新后的值」为准，未传字段沿用现值
    const currentAmount = existing.amount;
    const currentTax = existing.tax ?? new Prisma.Decimal(0);
    this.validateNetAmount(
      nextAmount ?? currentAmount,
      nextTax ?? currentTax,
    );

    const record = await this.prisma.dividendRecord.update({
      where: { id },
      data: {
        ...(dto.securityId !== undefined && { securityId: dto.securityId }),
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(nextAmount !== undefined && { amount: nextAmount }),
        ...(nextTax !== undefined && { tax: nextTax }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
      include: { security: SECURITY_SELECT },
    });

    return this.toResponse(record);
  }

  /**
   * 删除分红记录
   *
   * @param portfolioId 组合 ID
   * @param id 分红记录 ID
   * @param userId 当前用户 ID（数据隔离）
   */
  async remove(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<null> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const record = await this.prisma.dividendRecord.findFirst({
      where: { id, portfolioId },
      select: { id: true },
    });
    if (!record) {
      throw new NotFoundException('分红记录不存在');
    }

    await this.prisma.dividendRecord.delete({ where: { id } });
    return null;
  }
}
