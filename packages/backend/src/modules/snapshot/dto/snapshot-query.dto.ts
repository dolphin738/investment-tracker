/**
 * 资产快照查询参数 DTO
 *
 * 支持分页 + 日期范围筛选。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class SnapshotQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: '起始日期 YYYY-MM-DD（含）', example: '2025-01-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD（含）', example: '2025-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
