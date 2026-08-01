/**
 * 创建标的 DTO
 *
 * 对应 HOLD-P0-01：新增 Security 模型。
 * code 在同一组合内唯一；name 必填，长度 ≤ 50。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SecurityType } from '@prisma/client';

export class CreateSecurityDto {
  @ApiProperty({ description: '标的代码（同一组合内唯一）', example: '600519' })
  @IsString()
  @MaxLength(50)
  code!: string;

  @ApiProperty({ description: '标的名称', example: '贵州茅台' })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiPropertyOptional({
    description: '标的类型',
    enum: SecurityType,
    default: 'STOCK',
  })
  @IsOptional()
  @IsEnum(SecurityType)
  type?: SecurityType;

  @ApiPropertyOptional({
    description: '币种',
    default: 'CNY',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;
}
