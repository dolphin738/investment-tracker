/**
 * 更新偏好 DTO
 *
 * 所有字段可选。SET-P0-02：首次 get 时自动创建默认值。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
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
  @IsString()
  defaultGranularity?: string;

  @ApiPropertyOptional({
    description: '默认日期范围快捷项',
    enum: ['3m', '1y', 'ytd', 'all'],
  })
  @IsOptional()
  @IsString()
  defaultDateRange?: string;

  @ApiPropertyOptional({
    description: '周期聚合方式',
    enum: ['last', 'avg'],
  })
  @IsOptional()
  @IsString()
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
  @IsString()
  theme?: string;

  @ApiPropertyOptional({ description: '快照过期提醒阈值（天数）' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  staleDays?: number;
}
