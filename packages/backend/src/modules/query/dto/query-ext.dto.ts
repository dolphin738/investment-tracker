/**
 * 查询 DTO 补充 —— recalculate / summary / drawdown
 *
 * 与 query.dto.ts 互补，不含重复定义。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { DateRangeDto } from '../../../common/dto/date-range.dto';

/** 手动触发重算请求 */
export class RecalculateDto {
  @ApiPropertyOptional({
    description: '重算起始日期 YYYY-MM-DD（缺省从成立日起）',
    example: '2025-01-01',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: '重算结束日期 YYYY-MM-DD（缺省 = today）',
    example: '2025-12-31',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;
}

/** 回撤查询参数 */
export class DrawdownQueryDto extends DateRangeDto {}
