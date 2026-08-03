/**
 * CashFlow DTO — 出入金流水请求/响应类型
 *
 * 方案B：出入金是 XIRR 现金流唯一来源。
 * BUY=存入（现金流为负），SELL=取出（现金流为正）。
 * amount 始终 > 0。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CashFlowType } from '@investment-tracker/shared';

// ==================== 创建 ====================

export class CreateCashFlowDto {
  @ApiProperty({ description: '日期 YYYY-MM-DD', example: '2025-07-29' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '类型', enum: CashFlowType })
  @IsEnum(CashFlowType)
  type!: CashFlowType;

  @ApiProperty({ description: '金额（> 0）', example: 10000.0, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  amount!: number;

  @ApiPropertyOptional({ description: '备注', example: '工资入金' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 更新 ====================

export class UpdateCashFlowDto {
  @ApiPropertyOptional({ description: '日期 YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ description: '类型', enum: CashFlowType })
  @IsOptional()
  @IsEnum(CashFlowType)
  type?: CashFlowType;

  @ApiPropertyOptional({ description: '金额（> 0）', minimum: 0.01 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  amount?: number;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 查询 ====================

export class CashFlowQueryDto {
  @ApiPropertyOptional({ description: '起始日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: '类型筛选', enum: CashFlowType })
  @IsOptional()
  @IsEnum(CashFlowType)
  type?: CashFlowType;

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
