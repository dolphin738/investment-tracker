/**
 * 分红记录服务
 *
 * 职责：
 * - 分红记录 CRUD（create / findAll / findOne / delete）
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
import type { CreateDividendRecordDto } from './dto/create-dividend-record.dto';
import { Prisma } from '@prisma/client';

/** 分红记录响应 */
export interface DividendRecordResponse {
  id: string;
  portfolioId: string;
  securityId: string;
  securityName: string;
  securityCode: string;
  date: string;
  amount: string;
  type: string;
  note: string | null;
  createdAt: string;
}

@Injectable()
export class DividendService {
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
   * 新增分红记录
   */
  async create(
    portfolioId: string,
    userId: string,
    dto: CreateDividendRecordDto,
  ): Promise<DividendRecordResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const record = await this.prisma.dividendRecord.create({
      data: {
        portfolioId,
        securityId: dto.securityId,
        date: new Date(dto.date),
        amount: dto.amount,
        type: dto.type ?? 'CASH',
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
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    };
  }

  /**
   * 查询分红记录列表
   *
   * @param portfolioId 组合 ID
   * @param userId 用户 ID
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
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * 删除分红记录
   */
  async remove(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<null> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const record = await this.prisma.dividendRecord.findFirst({
      where: { id, portfolioId },
    });
    if (!record) {
      throw new NotFoundException('分红记录不存在');
    }

    await this.prisma.dividendRecord.delete({ where: { id } });
    return null;
  }
}
