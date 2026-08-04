/**
 * 交易多维查询 DTO
 *
 * 支持按 日/周/月/年 维度聚合交易数据。
 * 默认取期末值（last）。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { QueryGranularity, TransactionType } from '@investment-tracker/shared';

export class TransactionQueryDto {
  @ApiPropertyOptional({
    description: '查询粒度：day=按日 / week=按周 / month=按月 / year=按年',
    enum: QueryGranularity,
    default: QueryGranularity.MONTH,
  })
  @IsOptional()
  @IsEnum(QueryGranularity)
  granularity?: QueryGranularity = QueryGranularity.MONTH;

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
    description: '交易类型筛选：BUY / SELL',
    enum: TransactionType,
  })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiPropertyOptional({
    description: '标的 ID 筛选',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  securityId?: string;

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
