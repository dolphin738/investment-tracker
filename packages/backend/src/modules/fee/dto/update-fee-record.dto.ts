/**
 * 更新费用记录 DTO（增量 I-03 · 新增 PATCH /fees/:id）
 *
 * 全部字段可选（PATCH 语义）；服务层 resolve 当前值后校验：
 * - securityId 变更时走 validateSecurityInPortfolio 双闸（防跨组合挂载）
 * - amount 变更时校验 parseAmount > 0
 * - scenario 可修正（迁移后默认 BUY 的记录可在 UI 手动改为 SELL）
 *
 * 口径约束与 CreateFeeRecordDto 一致：NUMERIC(18,2) 字符串传输。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDecimal,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { FeeType, FeeScenario } from '@prisma/client';

export class UpdateFeeRecordDto {
  @ApiPropertyOptional({ description: '关联标的 ID（必须属于同一组合）' })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({
    description: '费用发生日期 YYYY-MM-DD',
    example: '2025-08-01',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    description: '费用金额（> 0，最多 2 位小数）',
    example: '5.00',
  })
  @IsOptional()
  @IsDecimal({ decimal_digits: '0,2' })
  amount?: string;

  @ApiPropertyOptional({
    description: '费用类型：COMMISSION 佣金 / STAMP_TAX 印花税 / OTHER 其他',
    enum: FeeType,
  })
  @IsOptional()
  @IsEnum(FeeType)
  type?: FeeType;

  @ApiPropertyOptional({
    description: '费用场景：BUY 买入时 / SELL 卖出时',
    enum: FeeScenario,
  })
  @IsOptional()
  @IsEnum(FeeScenario)
  scenario?: FeeScenario;

  @ApiPropertyOptional({ description: '备注（最长 200 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
