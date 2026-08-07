/**
 * SecurityTrade DTO — 证券买卖流水请求/响应类型
 *
 * 方案B：SecurityTrade 是持仓推导唯一来源。
 * BUY_SEC=买入，SELL_SEC=卖出。
 * quantity / costPrice / 分项费用为 Decimal 精度。
 *
 * INC-03（决策 B）：price 改名 costPrice（含费单价语义不变）。
 * INC-04（决策 A + F）：分项费用（commission/stampTax/other）直接承载于本表，
 *   fee_records 表已删除（推翻裁决 Q-8）；feeTotal = 三项之和（冗余展示列）。
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
import { SecuritySide } from '@investment-tracker/shared';

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

  @ApiProperty({
    description: '成交单价（含费单价，> 0）——INC-03 改名自原 price',
    example: 1500.45,
    minimum: 0.000001,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  costPrice!: number;

  @ApiPropertyOptional({
    description: '佣金（≥ 0，INC-04 物理并表至 security_trades）',
    example: 0,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  commission?: number;

  @ApiPropertyOptional({
    description: '印花税（≥ 0，INC-04 物理并表至 security_trades）',
    example: 0,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  stampTax?: number;

  @ApiPropertyOptional({
    description: '其他费用（≥ 0，INC-04 物理并表至 security_trades）',
    example: 0,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  other?: number;

  @ApiPropertyOptional({
    description: '费用合计（冗余列，恒等于 commission+stampTax+other；服务端以三分项之和覆盖）',
    example: 0,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  feeTotal?: number;

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

  @ApiPropertyOptional({ description: '成交单价（含费单价，> 0）', minimum: 0.000001 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(1e15)
  costPrice?: number;

  @ApiPropertyOptional({ description: '佣金（≥ 0）', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  commission?: number;

  @ApiPropertyOptional({ description: '印花税（≥ 0）', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  stampTax?: number;

  @ApiPropertyOptional({ description: '其他费用（≥ 0）', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  other?: number;

  @ApiPropertyOptional({ description: '费用合计（冗余列；服务端以三分项之和覆盖）', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  feeTotal?: number;

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

  @ApiPropertyOptional({ description: '买卖方向筛选', enum: SecuritySide })
  @IsOptional()
  @IsEnum(SecuritySide)
  side?: SecuritySide;

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
