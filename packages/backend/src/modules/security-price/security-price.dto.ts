/**
 * SecurityPrice DTO — 标的最新价请求/响应类型
 *
 * 方案B：SecurityPrice 按 asOf 日期向前沿用。
 * 同一 (portfolioId, securityId, asOf) 可有多条（取最新 createdAt），
 * 查询时取 asOf ≤ 目标日期的最新一条。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

// ==================== 创建 / 更新 ====================

export class UpsertSecurityPriceDto {
  @ApiProperty({ description: '标的 ID' })
  @IsString()
  securityId!: string;

  @ApiProperty({ description: '价格日期 YYYY-MM-DD', example: '2025-07-29' })
  @IsDateString()
  asOf!: string;

  @ApiProperty({ description: '价格（> 0）', example: 150.50, minimum: 0.000001 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  price!: number;
}

// ==================== 查询 ====================

export class SecurityPriceQueryDto {
  @ApiPropertyOptional({ description: '按标的 ID 筛选' })
  @IsOptional()
  @IsString()
  securityId?: string;

  @ApiPropertyOptional({ description: '起始日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数', default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;
}
