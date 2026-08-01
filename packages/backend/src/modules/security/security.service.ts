/**
 * 证券管理服务
 *
 * 职责：
 * - 标的 CRUD（create / findAll / findOne / update / delete）
 * - 数据隔离：所有查询以 portfolioId + userId 过滤
 * - 删除标的时若存在持仓记录，级联删除（Prisma onDelete: Cascade）
 *
 * 约束：
 * - 不依赖任何计算模块（C-08 / C-09）
 */

import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import type { Security as PrismaSecurity, SecurityType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateSecurityDto } from './dto/create-security.dto';
import type { UpdateSecurityDto } from './dto/update-security.dto';

/** API 响应中的标的结构 */
export interface SecurityResponse {
  id: string;
  portfolioId: string;
  code: string;
  name: string;
  type: SecurityType;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/** 将 Prisma 实体转为 API 响应 */
function toResponse(s: PrismaSecurity): SecurityResponse {
  return {
    id: s.id,
    portfolioId: s.portfolioId,
    code: s.code,
    name: s.name,
    type: s.type,
    currency: s.currency,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class SecurityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 验证组合归属权（数据隔离）
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
   * 创建标的
   *
   * @throws NotFoundException 组合不存在或不属于当前用户
   * @throws ConflictException 同一组合内 code 重复
   */
  async create(
    portfolioId: string,
    userId: string,
    dto: CreateSecurityDto,
  ): Promise<SecurityResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    // 检查 code 唯一性
    const existing = await this.prisma.security.findUnique({
      where: { portfolioId_code: { portfolioId, code: dto.code } },
    });
    if (existing) {
      throw new ConflictException(`标的代码 "${dto.code}" 已存在`);
    }

    const security = await this.prisma.security.create({
      data: {
        portfolioId,
        code: dto.code,
        name: dto.name,
        type: dto.type ?? 'STOCK',
        currency: dto.currency ?? 'CNY',
      },
    });
    return toResponse(security);
  }

  /**
   * 获取组合下所有标的
   */
  async findAll(
    portfolioId: string,
    userId: string,
  ): Promise<SecurityResponse[]> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const securities = await this.prisma.security.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' },
    });
    return securities.map(toResponse);
  }

  /**
   * 获取单个标的（含数据隔离校验）
   */
  async findOne(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<SecurityResponse> {
    await this.validatePortfolioOwnership(portfolioId, userId);

    const security = await this.prisma.security.findFirst({
      where: { id, portfolioId },
    });
    if (!security) {
      throw new NotFoundException('标的不存在');
    }
    return toResponse(security);
  }

  /**
   * 更新标的
   */
  async update(
    portfolioId: string,
    id: string,
    userId: string,
    dto: UpdateSecurityDto,
  ): Promise<SecurityResponse> {
    await this.findOne(portfolioId, id, userId);

    // 如果修改 code，检查唯一性
    if (dto.code) {
      const existing = await this.prisma.security.findUnique({
        where: { portfolioId_code: { portfolioId, code: dto.code } },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(`标的代码 "${dto.code}" 已存在`);
      }
    }

    const updated = await this.prisma.security.update({
      where: { id },
      data: {
        ...(dto.code !== undefined && { code: dto.code }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
      },
    });
    return toResponse(updated);
  }

  /**
   * 删除标的（级联删除关联持仓/分红/费用记录）
   */
  async remove(
    portfolioId: string,
    id: string,
    userId: string,
  ): Promise<null> {
    await this.findOne(portfolioId, id, userId);
    await this.prisma.security.delete({ where: { id } });
    return null;
  }
}
