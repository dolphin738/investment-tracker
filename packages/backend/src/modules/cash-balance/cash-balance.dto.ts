/**
 * CashBalance DTO — 现金余额请求/响应类型
 *
 * 方案B：CashBalance 独立管理现金余额，与前向沿用语义一致。
 * asOf ≤ 目标日期的最后一条为当前现金余额，首条之前 = 0。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ==================== 创建 / 更新 ====================

export class UpsertCashBalanceDto {
  @ApiProperty({ description: '余额日期 YYYY-MM-DD', example: '2025-07-29' })
  @IsDateString()
  asOf!: string;

  @ApiProperty({ description: '现金余额（≥ 0）', example: 50000.0, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e15)
  amount!: number;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 查询 ====================

export class CashBalanceQueryDto {
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

  @ApiPropertyOptional({ description: '每页条数', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  pageSize?: number = 20;
}
