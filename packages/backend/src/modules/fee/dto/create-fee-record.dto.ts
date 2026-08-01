/**
 * 创建费用记录 DTO
 *
 * 费用不进 Transaction 表、不触发计算（C-08 / C-09）。
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
import { FeeType } from '@prisma/client';

export class CreateFeeRecordDto {
  @ApiProperty({ description: '关联标的 ID' })
  @IsUUID()
  securityId!: string;

  @ApiProperty({ description: '费用发生日期 YYYY-MM-DD', example: '2025-08-01' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '费用金额（> 0）', example: '5.00' })
  @IsDecimal({ decimal_digits: '0,2' })
  amount!: string;

  @ApiPropertyOptional({
    description: '费用类型',
    enum: FeeType,
    default: 'OTHER',
  })
  @IsOptional()
  @IsEnum(FeeType)
  type?: FeeType;

  @ApiPropertyOptional({ description: '关联交易 ID' })
  @IsOptional()
  @IsUUID()
  transactionId?: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  note?: string;
}
