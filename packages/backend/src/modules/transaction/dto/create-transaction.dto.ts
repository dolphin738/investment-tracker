/**
 * 创建交易 DTO
 *
 * 校验规则（PRD §5.5）：
 * - amount > 0
 * - date 不可为未来日期（服务端额外校验）
 * - 首笔交易必须为买入（服务端额外校验）
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

  @ApiPropertyOptional({ description: '备注', example: '定投' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
