/**
 * 四维度查询参数 DTO
 *
 * 支持：
 * - granularity: day / week / month / year（默认 day）
 * - aggregation: last（期末值）/ avg（平均值）（默认 last）
 * - startDate / endDate: 日期范围
 * - metric: 净值查询的指标选择（cumulative / year / both）
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import {
  AggregationMethod,
  NavMetric,
  QueryGranularity,
} from '@investment-tracker/shared';
import { DateRangeDto } from '../../../common/dto/date-range.dto';

/** XIRR 查询参数 */
export class XirrQueryDto extends DateRangeDto {
  @ApiPropertyOptional({
    description: '查询粒度',
    enum: QueryGranularity,
    default: QueryGranularity.DAY,
  })
  @IsOptional()
  @IsEnum(QueryGranularity)
  granularity?: QueryGranularity = QueryGranularity.DAY;

  @ApiPropertyOptional({
    description: '聚合方式：last=期末值 / avg=平均值',
    enum: AggregationMethod,
    default: AggregationMethod.LAST,
  })
  @IsOptional()
  @IsEnum(AggregationMethod)
  aggregation?: AggregationMethod = AggregationMethod.LAST;
}

/** 净值查询参数 */
export class NavQueryDto extends DateRangeDto {
  @ApiPropertyOptional({
    description: '查询粒度',
    enum: QueryGranularity,
    default: QueryGranularity.DAY,
  })
  @IsOptional()
  @IsEnum(QueryGranularity)
  granularity?: QueryGranularity = QueryGranularity.DAY;

  @ApiPropertyOptional({
    description: '聚合方式：last=期末值 / avg=平均值',
    enum: AggregationMethod,
    default: AggregationMethod.LAST,
  })
  @IsOptional()
  @IsEnum(AggregationMethod)
  aggregation?: AggregationMethod = AggregationMethod.LAST;

  @ApiPropertyOptional({
    description: '返回指标选择（净值查询专用）',
    enum: NavMetric,
    default: NavMetric.BOTH,
  })
  @IsOptional()
  @IsEnum(NavMetric)
  metric?: NavMetric = NavMetric.BOTH;
}
