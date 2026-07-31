/**
 * 日期范围查询 DTO
 *
 * 用于按日期范围筛选数据。日期格式为 YYYY-MM-DD（ISO 8601 date-only）。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class DateRangeDto {
  @ApiPropertyOptional({
    description: '起始日期 YYYY-MM-DD（含）',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: '结束日期 YYYY-MM-DD（含）',
    example: '2025-12-31',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
