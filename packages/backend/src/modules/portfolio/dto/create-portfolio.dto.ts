/**
 * 创建组合 DTO
 *
 * currency 字段不在请求中指定，由服务端固定为 'CNY'（v1 单币种）。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePortfolioDto {
  @ApiProperty({ description: '组合名称', example: '我的股票投资' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: '组合描述', example: '长期价值投资组合' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
