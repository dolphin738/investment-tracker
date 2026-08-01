/**
 * 持仓 Upsert DTO
 *
 * 对应方案 A 持仓快照法：手工录入数量/成本/现价。
 * 每标的每日唯一（@@unique([securityId, date])），重复录入走 upsert 覆盖。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDecimal,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class UpsertHoldingDto {
  @ApiProperty({ description: '快照日期 YYYY-MM-DD', example: '2025-08-01' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '关联标的 ID' })
  @IsUUID()
  securityId!: string;

  @ApiProperty({
    description: '持仓数量（≥ 0，0 视为已清仓）',
    example: '50',
  })
  @IsDecimal({ decimal_digits: '0,6' })
  quantity!: string;

  @ApiProperty({
    description: '移动加权平均成本价（> 0）',
    example: '1500.00',
  })
  @IsDecimal({ decimal_digits: '0,6' })
  avgCost!: string;

  @ApiProperty({
    description: '现价（手工录入，> 0）',
    example: '1720.00',
  })
  @IsDecimal({ decimal_digits: '0,6' })
  marketPrice!: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  note?: string;
}
