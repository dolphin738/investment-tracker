/**
 * 导出查询 DTO（T05 · SET-P0-03）
 *
 * - type：7 类导出类型（shared ExportType 白名单）
 * - format：csv（缺省）| xlsx（Excel 扩展）
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { ExportType } from '@investment-tracker/shared';

export class ExportQueryDto {
  @ApiProperty({ description: '导出类型', enum: ExportType })
  @IsEnum(ExportType)
  type!: ExportType;

  @ApiPropertyOptional({
    description: '导出格式',
    enum: ['csv', 'xlsx'],
    default: 'csv',
  })
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx' = 'csv';
}
