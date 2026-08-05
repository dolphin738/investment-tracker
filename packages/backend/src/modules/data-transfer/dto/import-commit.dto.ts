/**
 * 导入提交 DTO（T05 · FLOW-P1-01 阶段二）
 *
 * - type：3 类导入类型（shared ImportType 白名单）
 * - token：preview 阶段返回的预览令牌（后端内存校验一致性，防越权提交）
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MinLength } from 'class-validator';
import { ImportType } from '@investment-tracker/shared';

export class ImportCommitDto {
  @ApiProperty({ description: '导入类型', enum: ImportType })
  @IsEnum(ImportType)
  type!: ImportType;

  @ApiProperty({ description: '预览令牌（preview 返回）' })
  @IsString()
  @MinLength(1)
  token!: string;
}
