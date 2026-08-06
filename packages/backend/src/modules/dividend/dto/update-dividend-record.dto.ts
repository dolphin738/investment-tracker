/**
 * 更新分红记录 DTO（增量设计 R-5 / C-3）
 *
 * 全部字段可选（PATCH 语义）；服务层 resolve 当前值后统一做净额校验：
 * - securityId 变更时走 validateSecurityInPortfolio 双闸（防跨组合挂载）
 * - amount / tax 变更时校验 parseAmount>0 / parseTax≥0 / validateNetAmount
 *
 * 口径约束与 CreateDividendRecordDto 一致：NUMERIC(18,2) 字符串传输。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDecimal,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class UpdateDividendRecordDto {
  @ApiPropertyOptional({ description: '关联标的 ID（必须属于同一组合）' })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({
    description: '分红日期 YYYY-MM-DD',
    example: '2025-07-15',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    description: '分红金额（> 0，最多 2 位小数）',
    example: '320.00',
  })
  @IsOptional()
  @IsDecimal({ decimal_digits: '0,2' })
  amount?: string;

  @ApiPropertyOptional({
    description: '所得税（≥ 0，最多 2 位小数；净额 = amount − tax 必须 ≥ 0）',
    example: '60.00',
  })
  @IsOptional()
  @IsDecimal({ decimal_digits: '0,2' })
  tax?: string;

  @ApiPropertyOptional({ description: '备注（最长 200 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
