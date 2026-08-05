/**
 * 导入预览 DTO（T05 · FLOW-P1-01 阶段一）
 *
 * 随 multipart 表单提交（file 字段由 FileInterceptor 取出，不在此 DTO 内）。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { ImportType } from '@investment-tracker/shared';

export class ImportPreviewDto {
  @ApiProperty({ description: '导入类型', enum: ImportType })
  @IsEnum(ImportType)
  type!: ImportType;
}
