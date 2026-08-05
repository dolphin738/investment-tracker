/**
 * 更新偏好 DTO
 *
 * 所有字段可选。SET-P0-02：首次 get 时自动创建默认值。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class UpdatePreferenceDto {
  @ApiPropertyOptional({
    description: '登录后自动选中的组合 ID（null / 空串 = 不设置默认组合）',
    nullable: true,
  })
  // 「不设置默认组合」在前端表单里天然是空串，直接透传会被 @IsUUID 判为
  // `defaultPortfolioId must be a UUID` 而 400。这里统一归一为 null，
  // 让「清空默认组合」与「设置默认组合」走同一条通路。
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @IsOptional()
  @IsUUID()
  defaultPortfolioId?: string | null;

  @ApiPropertyOptional({
    description: '默认时间维度',
    enum: ['day', 'week', 'month', 'year'],
  })
  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year'])
  defaultGranularity?: string;

  @ApiPropertyOptional({
    description: '默认日期范围快捷项',
    enum: ['3m', '1y', 'ytd', 'all'],
  })
  @IsOptional()
  @IsIn(['3m', '1y', 'ytd', 'all'])
  defaultDateRange?: string;

  @ApiPropertyOptional({
    description: '周期聚合方式',
    enum: ['last', 'avg'],
  })
  @IsOptional()
  @IsIn(['last', 'avg'])
  aggregation?: string;

  @ApiPropertyOptional({
    description: '按周聚合的周起始日（0=周日, 1=周一）',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  weekStartsOn?: number;

  @ApiPropertyOptional({ description: '净值展示小数位' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  navDecimals?: number;

  @ApiPropertyOptional({ description: 'XIRR 百分比小数位' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  xirrDecimals?: number;

  @ApiPropertyOptional({
    description: '外观主题',
    enum: ['light', 'dark', 'system'],
  })
  @IsOptional()
  @IsIn(['light', 'dark', 'system'])
  theme?: string;

  @ApiPropertyOptional({ description: '快照过期提醒阈值（天数）' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  staleDays?: number;

  @ApiPropertyOptional({ description: '持仓页「显示已清仓」初值（HOLD-B-P0-04）' })
  @IsOptional()
  @IsBoolean()
  showLiquidated?: boolean;

  // ===== Gap C 新增：软提示 / 金额格式（SET-P0-07 / SET-P1-03）=====
  // main.ts 的 ValidationPipe 开了 forbidNonWhitelisted，
  // 这 4 项不在 DTO 白名单里前端一提交就 400 —— 是解锁前端持久化的关键。

  @ApiPropertyOptional({ description: '出入金后现金余额软提示开关（SET-P0-07）' })
  @IsOptional()
  @IsBoolean()
  cashHintOnCashflow?: boolean;

  @ApiPropertyOptional({ description: '证券买卖后现金余额软提示开关（SET-P0-07）' })
  @IsOptional()
  @IsBoolean()
  cashHintOnTrade?: boolean;

  @ApiPropertyOptional({ description: '金额千分位（SET-P1-03）' })
  @IsOptional()
  @IsBoolean()
  amountThousands?: boolean;

  @ApiPropertyOptional({ description: '金额万 / 亿缩写（SET-P1-03）' })
  @IsOptional()
  @IsBoolean()
  amountAbbrev?: boolean;
}
