/**
 * SecurityTrade DTO — 证券买卖流水请求/响应类型
 *
 * 方案B：SecurityTrade 是持仓推导唯一来源。
 * BUY_SEC=买入，SELL_SEC=卖出。
 * quantity / price / fee 均为 Decimal 精度。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SecuritySide } from '@prisma/client';

// ==================== 创建 ====================

export class CreateSecurityTradeDto {
  @ApiProperty({ description: '标的 ID' })
  @IsString()
  securityId!: string;

  @ApiProperty({ description: '日期 YYYY-MM-DD', example: '2025-07-29' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '买卖方向', enum: SecuritySide })
  @IsEnum(SecuritySide)
  side!: SecuritySide;

  @ApiProperty({ description: '交易数量（> 0）', example: 100, minimum: 0.000001 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  quantity!: number;

  @ApiProperty({ description: '成交单价（> 0）', example: 150.50, minimum: 0.000001 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  price!: number;

  @ApiProperty({ description: '手续费（≥ 0）', example: 5.0, default: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  fee!: number;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 更新 ====================

export class UpdateSecurityTradeDto {
  @ApiPropertyOptional({ description: '标的 ID' })
  @IsOptional()
  @IsString()
  securityId?: string;

  @ApiPropertyOptional({ description: '日期 YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ description: '买卖方向', enum: SecuritySide })
  @IsOptional()
  @IsEnum(SecuritySide)
  side?: SecuritySide;

  @ApiPropertyOptional({ description: '交易数量（> 0）', minimum: 0.000001 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  quantity?: number;

  @ApiPropertyOptional({ description: '成交单价（> 0）', minimum: 0.000001 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  price?: number;

  @ApiPropertyOptional({ description: '手续费（≥ 0）' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  fee?: number;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 查询 ====================

export class SecurityTradeQueryDto {
  @ApiPropertyOptional({ description: '起始日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: '按标的 ID 筛选' })
  @IsOptional()
  @IsString()
  securityId?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  pageSize?: number = 20;
}
