/**
 * 创建交易 DTO
 *
 * 校验规则（PRD §5.5）：
 * - amount > 0
 * - date 不可为未来日期（服务端额外校验）
 * - 首笔交易必须为买入（服务端额外校验）
 * - securityId / quantity / price / fee 为 🆕 可选明细字段
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
  IsUUID,
} from 'class-validator';
import { TransactionType } from '@investment-tracker/shared';

export class CreateTransactionDto {
  @ApiProperty({
    description: '交易日期 YYYY-MM-DD（不可为未来日期）',
    example: '2025-07-29',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({
    description: '交易类型：BUY=买入 / SELL=卖出',
    enum: TransactionType,
    example: TransactionType.BUY,
  })
  @IsEnum(TransactionType)
  type!: TransactionType;

  @ApiProperty({
    description: '交易金额（> 0）',
    example: 10000.0,
    minimum: 0.01,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  amount!: number;

  // ─────────────── 🆕 明细扩展字段（全部可选）───────────────

  @ApiPropertyOptional({
    description: '关联标的 ID（UUID）',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({
    description: '交易数量（≥ 0）',
    example: 10.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e12)
  quantity?: number;

  @ApiPropertyOptional({
    description: '成交单价（≥ 0）',
    example: 1720.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e12)
  price?: number;

  @ApiPropertyOptional({
    description: '手续费（≥ 0，信息记录，已包含在 amount 内）',
    example: 5.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1e12)
  fee?: number;

  @ApiPropertyOptional({ description: '备注', example: '定投' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
