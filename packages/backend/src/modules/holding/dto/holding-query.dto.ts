/**
 * 持仓查询 DTO
 *
 * 按日期 + 标的类型筛选持仓明细。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { SecurityType } from '@prisma/client';

export class HoldingQueryDto {
  @ApiPropertyOptional({
    description: '快照日期 YYYY-MM-DD（默认最新有数据的一天）',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    description: '标的类型筛选（多选）',
    isArray: true,
    enum: SecurityType,
  })
  @IsOptional()
  @IsEnum(SecurityType, { each: true })
  types?: SecurityType[];
}
