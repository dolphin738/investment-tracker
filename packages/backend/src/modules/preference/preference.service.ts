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

import { Injectable } from '@nestjs/common';
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
