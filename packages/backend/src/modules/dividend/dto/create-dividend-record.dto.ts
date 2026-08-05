/**
 * 创建分红记录 DTO（HOLD-B-P0-10 / 阶段 C · Q-1 A）
 *
 * 口径约束：
 * - 金额精度遵循 PRD §8.1：NUMERIC(18,2)，以字符串传输避免 JS 浮点丢精
 * - 分红不进 CashFlow 表、不触发计算引擎（D-02 / C-08）
 * - 红利再投（STOCK_DIVIDEND）仅作信息记录，无现金进出
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDecimal,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { DividendType } from '@prisma/client';

export class CreateDividendRecordDto {
  @ApiProperty({ description: '关联标的 ID（必须属于同一组合）' })
  @IsUUID()
  securityId!: string;

  @ApiProperty({ description: '分红日期 YYYY-MM-DD', example: '2025-07-15' })
  @IsDateString()
  date!: string;

  @ApiProperty({
    description: '分红金额（> 0，最多 2 位小数）',
    example: '320.00',
  })
  @IsDecimal({ decimal_digits: '0,2' })
  amount!: string;

  @ApiPropertyOptional({
    description: '分红类型：CASH 现金分红 / STOCK_DIVIDEND 红利再投',
    enum: DividendType,
    default: DividendType.CASH,
  })
  @IsOptional()
  @IsEnum(DividendType)
  type?: DividendType;

  @ApiPropertyOptional({ description: '备注（最长 200 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
