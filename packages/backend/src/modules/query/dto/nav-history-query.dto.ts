/**
 * 净值历史查询 DTO
 *
 * 支持按 日/周/月/年 维度聚合，带分页。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import {
  AggregationMethod,
  NavMetric,
  QueryGranularity,
} from '@investment-tracker/shared';

export class NavHistoryQueryDto {
  @ApiPropertyOptional({
    description: '查询粒度',
    enum: QueryGranularity,
    default: QueryGranularity.MONTH,
  })
  @IsOptional()
  @IsEnum(QueryGranularity)
  granularity?: QueryGranularity = QueryGranularity.MONTH;

  @ApiPropertyOptional({
    description: '聚合方式：last=期末值 / avg=平均值',
    enum: AggregationMethod,
    default: AggregationMethod.LAST,
  })
  @IsOptional()
  @IsEnum(AggregationMethod)
  aggregation?: AggregationMethod = AggregationMethod.LAST;

  @ApiPropertyOptional({
    description: '返回指标选择',
    enum: NavMetric,
    default: NavMetric.BOTH,
  })
  @IsOptional()
  @IsEnum(NavMetric)
  metric?: NavMetric = NavMetric.BOTH;

  @ApiPropertyOptional({
    description: '起始日期 YYYY-MM-DD（含）',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: '结束日期 YYYY-MM-DD（含）',
    example: '2025-12-31',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: '页码，从 1 开始',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: '每页条数',
    default: 20,
    minimum: 1,
    maximum: 200,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;
}
