/**
 * 交易列表查询 DTO
 *
 * 扩展分页 + 日期范围，新增 type / securityId 筛选参数。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TransactionType } from '@investment-tracker/shared';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { DateRangeDto } from '../../../common/dto/date-range.dto';

export class TransactionQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: '起始日期 YYYY-MM-DD（含）',
    example: '2025-01-01',
  })
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: '结束日期 YYYY-MM-DD（含）',
    example: '2025-12-31',
  })
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({
    description: '交易类型筛选：BUY / SELL',
    enum: TransactionType,
  })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiPropertyOptional({
    description: '标的 ID 筛选',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  securityId?: string;
}
