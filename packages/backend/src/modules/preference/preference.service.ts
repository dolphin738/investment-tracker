/**
 * 用户偏好服务
 *
 * 职责：
 * - 获取偏好（get）：首次调用时自动创建默认值
 * - 更新偏好（update）：按 userId 唯一
 *
 * 默认值（SET-P0-02）：
 * - defaultGranularity: 'month'
 * - defaultDateRange: '1y'
 * - aggregation: 'last'
 * - weekStartsOn: 1
 * - navDecimals: 4
 * - xirrDecimals: 2
 * - theme: 'system'
 * - staleDays: 3
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { UpdatePreferenceDto } from './dto/update-preference.dto';

/** 偏好响应 */
export interface PreferenceResponse {
  id: string;
  userId: string;
  defaultPortfolioId: string | null;
  defaultGranularity: string;
  defaultDateRange: string;
  aggregation: string;
  weekStartsOn: number;
  navDecimals: number;
  xirrDecimals: number;
  theme: string;
  staleDays: number;
  createdAt: string;
  updatedAt: string;
}

/** 系统默认偏好值 */
const DEFAULTS = {
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
};

@Injectable()
export class PreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取用户偏好（首次调用时自动创建默认值）
   */
  async get(userId: string): Promise<PreferenceResponse> {
    let pref = await this.prisma.userPreference.findUnique({
      where: { userId },
    });

    if (!pref) {
      pref = await this.prisma.userPreference.create({
        data: {
          userId,
          defaultGranularity: DEFAULTS.defaultGranularity,
          defaultDateRange: DEFAULTS.defaultDateRange,
          aggregation: DEFAULTS.aggregation,
          weekStartsOn: DEFAULTS.weekStartsOn,
          navDecimals: DEFAULTS.navDecimals,
          xirrDecimals: DEFAULTS.xirrDecimals,
          theme: DEFAULTS.theme,
          staleDays: DEFAULTS.staleDays,
        },
      });
    }

    // 自愈：默认组合可能已被删除或归档（归档组合已从选择器隐藏）。
    // 继续把失效 ID 回传给前端，只会让「重设默认组合」一直携带一个选不回来的旧值，
    // 因此这里就地清空，保证 GET 出去的默认组合永远是「存在且未归档」的。
    if (
      pref.defaultPortfolioId &&
      !(await this.isSelectablePortfolio(userId, pref.defaultPortfolioId))
    ) {
      pref = await this.prisma.userPreference.update({
        where: { userId },
        data: { defaultPortfolioId: null },
      });
    }

    return {
      id: pref.id,
      userId: pref.userId,
      defaultPortfolioId: pref.defaultPortfolioId,
      defaultGranularity: pref.defaultGranularity,
      defaultDateRange: pref.defaultDateRange,
      aggregation: pref.aggregation,
      weekStartsOn: pref.weekStartsOn,
      navDecimals: pref.navDecimals,
      xirrDecimals: pref.xirrDecimals,
      theme: pref.theme,
      staleDays: pref.staleDays,
      createdAt: pref.createdAt.toISOString(),
      updatedAt: pref.updatedAt.toISOString(),
    };
  }

  /**
   * 判断组合是否可被选为「默认组合」：属于该用户、存在、且未归档。
   */
  private async isSelectablePortfolio(
    userId: string,
    portfolioId: string,
  ): Promise<boolean> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId, archivedAt: null },
      select: { id: true },
    });
    return portfolio !== null;
  }

  /**
   * 更新用户偏好
   *
   * 先确保偏好记录存在，再更新。
   */
  async update(
    userId: string,
    dto: UpdatePreferenceDto,
  ): Promise<PreferenceResponse> {
    // 确保记录存在
    const existing = await this.prisma.userPreference.findUnique({
      where: { userId },
    });

    if (!existing) {
      await this.prisma.userPreference.create({
        data: {
          userId,
          defaultGranularity: DEFAULTS.defaultGranularity,
          defaultDateRange: DEFAULTS.defaultDateRange,
          aggregation: DEFAULTS.aggregation,
          weekStartsOn: DEFAULTS.weekStartsOn,
          navDecimals: DEFAULTS.navDecimals,
          xirrDecimals: DEFAULTS.xirrDecimals,
          theme: DEFAULTS.theme,
          staleDays: DEFAULTS.staleDays,
        },
      });
    }

    // 默认组合：只接受「属于本人、存在且未归档」的组合。
    // 校验失败给出可读原因，而不是让前端只看到一个 class-validator 的 UUID 报错。
    if (dto.defaultPortfolioId) {
      const selectable = await this.isSelectablePortfolio(
        userId,
        dto.defaultPortfolioId,
      );
      if (!selectable) {
        throw new BadRequestException(
          '默认组合不存在、无权访问或已归档，请选择其他组合',
        );
      }
    }

    // 构建更新数据
    const data: Record<string, unknown> = {};
    if (dto.defaultPortfolioId !== undefined)
      data.defaultPortfolioId = dto.defaultPortfolioId;
    if (dto.defaultGranularity !== undefined)
      data.defaultGranularity = dto.defaultGranularity;
    if (dto.defaultDateRange !== undefined)
      data.defaultDateRange = dto.defaultDateRange;
    if (dto.aggregation !== undefined)
      data.aggregation = dto.aggregation;
    if (dto.weekStartsOn !== undefined)
      data.weekStartsOn = dto.weekStartsOn;
    if (dto.navDecimals !== undefined)
      data.navDecimals = dto.navDecimals;
    if (dto.xirrDecimals !== undefined)
      data.xirrDecimals = dto.xirrDecimals;
    if (dto.theme !== undefined)
      data.theme = dto.theme;
    if (dto.staleDays !== undefined)
      data.staleDays = dto.staleDays;

    const pref = await this.prisma.userPreference.update({
      where: { userId },
      data,
    });

    return {
      id: pref.id,
      userId: pref.userId,
      defaultPortfolioId: pref.defaultPortfolioId,
      defaultGranularity: pref.defaultGranularity,
      defaultDateRange: pref.defaultDateRange,
      aggregation: pref.aggregation,
      weekStartsOn: pref.weekStartsOn,
      navDecimals: pref.navDecimals,
      xirrDecimals: pref.xirrDecimals,
      theme: pref.theme,
      staleDays: pref.staleDays,
      createdAt: pref.createdAt.toISOString(),
      updatedAt: pref.updatedAt.toISOString(),
    };
  }
}
