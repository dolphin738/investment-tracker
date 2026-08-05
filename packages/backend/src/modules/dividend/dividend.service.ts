/**
 * 分红记录服务（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复）
 *
 * 职责：
 * - 分红记录 CRUD（create / findAll / remove）
 * - 数据隔离：所有读写先校验 portfolio.userId === 当前用户（与 CashFlowService 同范式）
 * - 二级隔离：securityId 必须属于同一组合，杜绝跨组合挂载标的
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

/** 分红记录响应（金额以字符串传输，保持 NUMERIC(18,2) 精度） */
export interface DividendRecordResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  amount: string;
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
   * 解析并校验金额：必须 > 0（PRD HOLD-B-P0-10）
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

  /** Prisma 记录 → 响应 DTO */
  private toResponse(record: {
    id: string;
    portfolioId: string;
    securityId: string;
    date: Date;
    amount: Prisma.Decimal;
    type: DividendType;
    note: string | null;
    createdAt: Date;
    security: { name: string; code: string };
  }): DividendRecordResponse {
    return {
      id: record.id,
      portfolioId: record.portfolioId,
      securityId: record.securityId,
      securityName: record.security.name,
      securityCode: record.security.code,
      date: record.date.toISOString().split('T')[0],
      amount: record.amount.toString(),
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

    const record = await this.prisma.dividendRecord.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        date: new Date(dto.date),
        amount,
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
