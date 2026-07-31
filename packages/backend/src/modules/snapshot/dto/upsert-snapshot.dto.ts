/**
 * 资产快照 upsert DTO
 *
 * 每个组合每日仅一条快照（portfolioId + date 唯一约束）。
 * 重复录入时 upsert 覆盖（重复则更新 totalAsset）。
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

export class UpsertSnapshotDto {
  @ApiProperty({
    description: '快照日期 YYYY-MM-DD（不可为未来日期）',
    example: '2025-07-29',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({
    description: '当日持仓总市值（> 0）',
    example: 12000.0,
    minimum: 0.01,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  totalAsset!: number;

  @ApiPropertyOptional({ description: '备注', example: '月末估值' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
