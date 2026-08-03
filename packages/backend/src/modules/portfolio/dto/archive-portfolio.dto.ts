/**
 * 归档组合 DTO
 *
 * 语义：
 * - archived 缺省（undefined）→ 归档（archivedAt = now）
 * - archived: true            → 归档（archivedAt = now）
 * - archived: false           → 取消归档（archivedAt = null）
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class ArchivePortfolioDto {
  @ApiPropertyOptional({
    description: '归档状态：true=归档，false=取消归档（缺省视为归档）',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
