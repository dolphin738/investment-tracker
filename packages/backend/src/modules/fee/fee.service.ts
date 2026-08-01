/**
 * 费用记录服务
 *
 * 职责：
 * - 费用记录 CRUD（create / findAll / delete）
 * - 数据隔离：所有查询以 portfolioId + userId 过滤
 * - 按 portfolioId / holdingId（securityId）过滤
 *
 * ⚠️ 约束（C-08 / C-09）：
 * - 不进 Transaction 表
 * - 不触发计算引擎
 * - 不导入 CalculationModule
 */

import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateFeeRecordDto } from './dto/create-fee-record.dto';
import { Prisma } from '@prisma/client';

/** 费用记录响应 */
export interface FeeRecordResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  amount: string;
  type: string;
  transactionId: string | null;
  note: string | null;
  createdAt: string;
}

@Injectable()
export class FeeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 验证组合归属权
   */
  private async validatePortfolioOwnership(
    portfolioId: string,
    userId: string,
  ): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  /**
   * 新增费用记录
   */
  async create(
    portfolioId: string,
    userId: string,
    dto: CreateFeeRecordDto,
  ): Promise<FeeRecordResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const record = await this.prisma.feeRecord.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        date: new Date(dto.date),
        amount: dto.amount,
        type: dto.type ?? 'OTHER',
        transactionId: dto.transactionId,
        note: dto.note,
      },
      include: {
        security: { select: { name: true, code: true } },
      },
    });

    return {
      id: record.id,
      portfolioId: record.portfolioId,
      securityId: record.securityId,
      securityName: record.security.name,
      securityCode: record.security.code,
      date: record.date.toISOString().split('T')[0],
      amount: record.amount.toString(),
      type: record.type,
      transactionId: record.transactionId,
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    };
  }

  /**
   * 查询费用记录列表
   *
   * @param portfolioId 组合 ID
   * @param userId 用户 ID
   * @param securityId 可选：按标的过滤
   */
  async findAll(
    portfolioId: string,
    userId: string,
    securityId?: string,
  ): Promise<FeeRecordResponse[]> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const where: Prisma.FeeRecordWhereInput = { portfolioId };
    if (securityId) {
      where.securityId = securityId;
    }

    const records = await this.prisma.feeRecord.findMany({
      where,
      include: {
        security: { select: { name: true, code: true } },
      },
      orderBy: { date: 'desc' },
    });

    return records.map((r) => ({
      id: r.id,
      portfolioId: r.portfolioId,
      securityId: r.securityId,
      securityName: r.security.name,
      securityCode: r.security.code,
      date: r.date.toISOString().split('T')[0],
      amount: r.amount.toString(),
      type: r.type,
      transactionId: r.transactionId,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * 删除费用记录
   */
  async remove(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<null> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const record = await this.prisma.feeRecord.findFirst({
      where: { id, portfolioId },
    });
    if (!record) {
      throw new NotFoundException('费用记录不存在');
    }

    await this.prisma.feeRecord.delete({ where: { id } });
    return null;
  }
}
