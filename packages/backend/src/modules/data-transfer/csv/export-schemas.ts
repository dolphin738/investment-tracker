/**
 * csv/export-schemas.ts — 7 类导出的列定义（T05 · SET-P0-03）
 *
 * 约定：
 * - 表头使用**英文字段名**，与 API / Prisma 字段一致（保证「导出 → 修改 → 导入」闭环）。
 * - Decimal 一律以 **string** 原样输出（不科学计数、不丢精度）。
 * - 日期一律 `YYYY-MM-DD`（`@db.Date` 列）；时间戳（createdAt/updatedAt/recordedAt）为 ISO 8601。
 * - navSeries 列 = date/cumulativeNav/yearlyNav/shares/totalAsset/xirr（O-1 默认），
 *   totalAsset 取当日 AssetSnapshot（无记录留空）、xirr 取当日 DailyXirr（无记录留空）。
 */

import { ExportType } from '@investment-tracker/shared';

export interface ExportColumn {
  /** 对象取值键（Prisma 返回字段名） */
  key: string;
  /** 表头（英文字段名，与 key 一致） */
  label: string;
  /** Decimal 精度（导出时按此格式化；null = 原样 string / 日期 / 枚举） */
  precision?: number;
}

export const EXPORT_SCHEMAS: Record<ExportType, ExportColumn[]> = {
  [ExportType.SECURITIES]: [
    { key: 'id', label: 'id' },
    { key: 'portfolioId', label: 'portfolioId' },
    { key: 'code', label: 'code' },
    { key: 'name', label: 'name' },
    { key: 'type', label: 'type' },
    { key: 'currency', label: 'currency' },
    { key: 'createdAt', label: 'createdAt' },
    { key: 'updatedAt', label: 'updatedAt' },
  ],
  [ExportType.SECURITY_TRADES]: [
    { key: 'id', label: 'id' },
    { key: 'portfolioId', label: 'portfolioId' },
    { key: 'securityId', label: 'securityId' },
    { key: 'date', label: 'date' },
    { key: 'side', label: 'side' },
    { key: 'quantity', label: 'quantity', precision: 6 },
    { key: 'price', label: 'price', precision: 6 },
    { key: 'fee', label: 'fee', precision: 2 },
    { key: 'note', label: 'note' },
    { key: 'createdAt', label: 'createdAt' },
    { key: 'updatedAt', label: 'updatedAt' },
  ],
  [ExportType.CASH_FLOWS]: [
    { key: 'id', label: 'id' },
    { key: 'portfolioId', label: 'portfolioId' },
    { key: 'date', label: 'date' },
    { key: 'type', label: 'type' },
    { key: 'amount', label: 'amount', precision: 2 },
    { key: 'note', label: 'note' },
    { key: 'createdAt', label: 'createdAt' },
    { key: 'updatedAt', label: 'updatedAt' },
  ],
  [ExportType.CASH_BALANCES]: [
    { key: 'id', label: 'id' },
    { key: 'portfolioId', label: 'portfolioId' },
    { key: 'amount', label: 'amount', precision: 2 },
    { key: 'asOf', label: 'asOf' },
    { key: 'note', label: 'note' },
    { key: 'createdAt', label: 'createdAt' },
  ],
  [ExportType.SECURITY_PRICES]: [
    { key: 'id', label: 'id' },
    { key: 'portfolioId', label: 'portfolioId' },
    { key: 'securityId', label: 'securityId' },
    { key: 'price', label: 'price', precision: 6 },
    { key: 'asOf', label: 'asOf' },
    { key: 'createdAt', label: 'createdAt' },
  ],
  [ExportType.ASSET_SNAPSHOTS]: [
    { key: 'id', label: 'id' },
    { key: 'portfolioId', label: 'portfolioId' },
    { key: 'date', label: 'date' },
    { key: 'totalAsset', label: 'totalAsset', precision: 2 },
    { key: 'marketValue', label: 'marketValue', precision: 2 },
    { key: 'cashBalance', label: 'cashBalance', precision: 2 },
    { key: 'source', label: 'source' },
    { key: 'valuationFlag', label: 'valuationFlag' },
    { key: 'note', label: 'note' },
    { key: 'recordedAt', label: 'recordedAt' },
    { key: 'createdAt', label: 'createdAt' },
    { key: 'updatedAt', label: 'updatedAt' },
  ],
  [ExportType.NAV_SERIES]: [
    { key: 'date', label: 'date' },
    { key: 'cumulativeNav', label: 'cumulativeNav', precision: 6 },
    { key: 'yearNav', label: 'yearNav', precision: 6 },
    { key: 'shares', label: 'shares', precision: 6 },
    { key: 'totalAsset', label: 'totalAsset', precision: 2 },
    { key: 'xirr', label: 'xirr', precision: 8 },
  ],
};
