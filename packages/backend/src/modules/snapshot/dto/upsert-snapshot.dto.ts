/**
 * 资产快照 DTO（方案B）
 *
 * 支持 source=MANUAL/DERIVED、marketValue/cashBalance 拆解、valuationFlag 估值标识。
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
import { SnapshotValuation } from '@prisma/client';
import { SnapshotSource } from '@investment-tracker/shared';

// ==================== 手工录入 / 更新 ====================

export class UpsertSnapshotDto {
  @ApiProperty({ description: '快照日期 YYYY-MM-DD', example: '2025-07-29' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '当日总资产（> 0）', example: 120000.0, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  totalAsset!: number;

  @ApiPropertyOptional({ description: '持仓市值合计' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  marketValue?: number;

  @ApiPropertyOptional({ description: '当日现金余额' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  cashBalance?: number;

  @ApiPropertyOptional({
    description: '估值标识',
    enum: SnapshotValuation,
    default: SnapshotValuation.MANUAL_INPUT,
  })
  @IsOptional()
  @IsEnum(SnapshotValuation)
  valuationFlag?: SnapshotValuation;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 查询 ====================

export class SnapshotQueryDto {
  @ApiPropertyOptional({ description: '起始日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: '来源筛选：DERIVED=自动 / MANUAL=手工（不传则不过滤）',
    enum: SnapshotSource,
  })
  @IsOptional()
  @IsEnum(SnapshotSource)
  source?: SnapshotSource;

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
