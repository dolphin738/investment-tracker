/**
 * 创建分红记录 DTO
 *
 * 分红不进 Transaction 表、不触发计算（C-08 / C-09）。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDecimal,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { DividendType } from '@prisma/client';

export class CreateDividendRecordDto {
  @ApiProperty({ description: '关联标的 ID' })
  @IsUUID()
  securityId!: string;

  @ApiProperty({ description: '分红日期 YYYY-MM-DD', example: '2025-07-15' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '分红金额（> 0）', example: '320.00' })
  @IsDecimal({ decimal_digits: '0,2' })
  amount!: string;

  @ApiPropertyOptional({
    description: '分红类型',
    enum: DividendType,
    default: 'CASH',
  })
  @IsOptional()
  @IsEnum(DividendType)
  type?: DividendType;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  note?: string;
}
