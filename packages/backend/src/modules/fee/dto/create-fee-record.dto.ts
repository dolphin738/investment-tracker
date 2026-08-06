/**
 * 创建费用记录 DTO（HOLD-B-P0-10 / 阶段 C · Q-1 A）
 *
 * 口径约束：
 * - 金额精度遵循 PRD §8.1：NUMERIC(18,2)，以字符串传输避免 JS 浮点丢精
 * - 费用不进 CashFlow 表、不触发计算引擎（D-03 / C-09）
 * - 与 SecurityTrade.fee（计入成本）是两套口径：本表仅信息记录，不回冲成本
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateFeeRecordDto {
  @ApiProperty({ description: '关联标的 ID（必须属于同一组合）' })
  @IsUUID()
  securityId!: string;

  @ApiProperty({ description: '费用发生日期 YYYY-MM-DD', example: '2025-08-01' })
  @IsDateString()
  date!: string;

  @ApiProperty({
    description: '费用金额（> 0，最多 2 位小数）',
    example: '5.00',
  })
  @IsDecimal({ decimal_digits: '0,2' })
  amount!: string;

  @ApiPropertyOptional({
    description: '费用类型：COMMISSION 佣金 / STAMP_TAX 印花税 / OTHER 其他',
    enum: FeeType,
    default: FeeType.OTHER,
  })
  @IsOptional()
  @IsEnum(FeeType)
  type?: FeeType;

  // 🆕 I-03：费用场景（BUY=买入时 / SELL=卖出时）。
  // 服务层推断优先：dto.scenario ?? (transactionId → SecurityTrade.side) ?? BUY
  @ApiPropertyOptional({
    description: '费用场景：BUY 买入时 / SELL 卖出时（缺省按 transactionId 推断，无法推断默认 BUY）',
    enum: FeeScenario,
    default: FeeScenario.BUY,
  })
  @IsOptional()
  @IsEnum(FeeScenario)
  scenario?: FeeScenario;

  @ApiPropertyOptional({ description: '关联证券买卖流水 ID（可选）' })
  @IsOptional()
  @IsUUID()
  transactionId?: string;

  @ApiPropertyOptional({ description: '备注（最长 200 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
