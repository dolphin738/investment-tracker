/**
 * 模板下载查询 DTO（T05 · SET-P0-04）
 *
 * 不需要 portfolioId：模板与具体组合无关（含英文表头 + 1 行示例）。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { ImportType } from '@investment-tracker/shared';

export class TemplateQueryDto {
  @ApiProperty({ description: '导入类型', enum: ImportType })
  @IsEnum(ImportType)
  type!: ImportType;

  @ApiPropertyOptional({
    description: '模板格式',
    enum: ['csv', 'xlsx'],
    default: 'csv',
  })
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx' = 'csv';
}
