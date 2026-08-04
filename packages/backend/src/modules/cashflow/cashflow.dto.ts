/**
 * CashFlow DTO — 出入金流水请求/响应类型
 *
 * 方案B：出入金是 XIRR 现金流唯一来源。
 * BUY=存入（现金流为负），SELL=取出（现金流为正）。
 * amount 始终 > 0。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CashFlowType } from '@investment-tracker/shared';

// ==================== 创建 ====================

export class CreateCashFlowDto {
  @ApiProperty({ description: '日期 YYYY-MM-DD', example: '2025-07-29' })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: '类型', enum: CashFlowType })
  @IsEnum(CashFlowType)
  type!: CashFlowType;

  @ApiProperty({ description: '金额（> 0）', example: 10000.0, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  amount!: number;

  @ApiPropertyOptional({ description: '备注', example: '工资入金' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 更新 ====================

export class UpdateCashFlowDto {
  @ApiPropertyOptional({ description: '日期 YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ description: '类型', enum: CashFlowType })
  @IsOptional()
  @IsEnum(CashFlowType)
  type?: CashFlowType;

  @ApiPropertyOptional({ description: '金额（> 0）', minimum: 0.01 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1e15)
  amount?: number;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ==================== 查询 ====================

export class CashFlowQueryDto {
  @ApiPropertyOptional({ description: '起始日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束日期 YYYY-MM-DD（含）' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: '类型筛选', enum: CashFlowType })
  @IsOptional()
  @IsEnum(CashFlowType)
  type?: CashFlowType;

  /**
   * 类型多选筛选（F2）。
   *
   * URL query 传参（对齐设计文档 Part E-2）：
   * - 逗号分隔：`types=BUY,SELL`
   * - 重复参数：`types=BUY&types=SELL`（NestJS 解析为数组）
   * - 空数组 / 未传 = 全部（与「重置」语义一致）
   *
   * 注意：axios 默认会把数组序列化成 `types[]=...`（带方括号），
   * 在 forbidNonWhitelisted 下会被 400 拒绝；前端必须传逗号分隔字符串
   * 或使用 paramsSerializer（arrayFormat: 'repeat'）。
   */
  @ApiPropertyOptional({
    description: '类型多选筛选（逗号分隔或重复参数；空数组=全部）',
    enum: CashFlowType,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') {
      return value;
    }
    if (Array.isArray(value)) {
      return value;
    }
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  })
  @IsArray()
  @IsEnum(CashFlowType, { each: true })
  types?: CashFlowType[];

  @ApiPropertyOptional({
    description: '排序字段（白名单：date=日期 / amount=金额）',
    enum: ['date', 'amount'],
    default: 'date',
  })
  @IsOptional()
  @IsIn(['date', 'amount'])
  sortBy?: 'date' | 'amount' = 'date';

  @ApiPropertyOptional({
    description: '排序方向',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({ description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页条数', default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;
}
