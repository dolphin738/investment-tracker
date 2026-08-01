/**
 * 组合管理服务
 *
 * 职责：
 * - 组合 CRUD（创建 / 查询列表 / 查询单个 / 更新 / 删除）
 * - 数据隔离：所有查询以 userId 过滤，用户只能操作自己的组合
 * - 创建时固定 currency = 'CNY'（v1 单币种）
 * - 全量重算入口（recalculateAll）：口径变更/数据修复后重建全部历史净值与 XIRR
 *
 * Decimal/Date 序列化：
 * - baseDate（@db.Date）转为 YYYY-MM-DD 字符串
 * - createdAt/updatedAt（DateTime）转为 ISO 8601 字符串
 */

import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Portfolio as PrismaPortfolio } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../calculation/recalculation.service';

/** API 响应中的组合结构（日期字段转为字符串） */
export interface PortfolioResponse {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  baseDate: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应（日期 → 字符串） */
function toResponse(p: PrismaPortfolio): PortfolioResponse {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description,
    baseDate: p.baseDate ? p.baseDate.toISOString().split('T')[0] : null,
    currency: p.currency,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** 全量重算 API 响应 */
export interface RecalculateResponse {
  /** 组合 ID */
  portfolioId: string;
  /** 重算起始日期 YYYY-MM-DD（组合成立日 = 第一笔买入日） */
  fromDate: string;
  /** 受影响日期数（重算的快照日期数） */
  affectedDays: number;
}

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /**
   * 创建组合（currency 固定为 CNY）
   */
  async create(userId: string, name: string, description?: string): Promise<PortfolioResponse> {
    const portfolio = await this.prisma.portfolio.create({
      data: {
        userId,
        name,
        description,
        currency: 'CNY',
      },
    });
    return toResponse(portfolio);
  }

  /**
   * 获取当前用户的所有组合
   */
  async findAll(userId: string): Promise<PortfolioResponse[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return portfolios.map(toResponse);
  }

  /**
   * 获取单个组合（含数据隔离校验）
   *
   * @throws NotFoundException 组合不存在或不属于当前用户
   */
  async findOne(userId: string, id: string): Promise<PortfolioResponse> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
    return toResponse(portfolio);
  }

  /**
   * 更新组合（仅 name / description）
   */
  async update(
    userId: string,
    id: string,
    data: { name?: string; description?: string },
  ): Promise<PortfolioResponse> {
    await this.findOne(userId, id);

    const updated = await this.prisma.portfolio.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
    return toResponse(updated);
  }

  /**
   * 删除组合（级联删除其下所有交易/快照/净值/XIRR）
   */
  async remove(userId: string, id: string): Promise<null> {
    await this.findOne(userId, id);
    await this.prisma.portfolio.delete({ where: { id } });
    return null;
  }

  /**
   * 全量重算：从组合成立日重算到最后一个有快照的日期
   *
   * 使用场景：计算口径变更（如 D-06 资产快照口径调整）后历史净值/XIRR 全部失效，
   * 需要一次性重建。
   *
   * @throws NotFoundException 组合不存在或不属于当前用户
   * @throws BadRequestException 组合尚无买入交易（由 RecalculationService 抛出）
   */
  async recalculateAll(userId: string, id: string): Promise<RecalculateResponse> {
    // 数据隔离：仅允许重算属于当前用户的组合
    await this.findOne(userId, id);

    const { fromDate, affectedDays } = await this.recalculationService.recalculateAll(id);

    return {
      portfolioId: id,
      fromDate: fromDate.toISOString().split('T')[0],
      affectedDays,
    };
  }
}
