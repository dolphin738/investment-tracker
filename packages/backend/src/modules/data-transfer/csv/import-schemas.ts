/**
 * csv/import-schemas.ts — 3 类导入的行校验 schema（T05 · FLOW-P1-01）
 *
 * 约定（增量设计 §7.7 / §7.8）：
 * - 所有值以 string 读入（CSV / XLSX 归一化后），此处做**格式 + 枚举 + 精度**校验。
 * - 日期一律 `YYYY-MM-DD`；Decimal 用字符串正则校验小数位（超精度报错，不静默截断）。
 * - 错误码：MISSING_REQUIRED_COLUMN / INVALID_DATE_FORMAT / INVALID_DECIMAL_PRECISION /
 *   INVALID_ENUM_VALUE / SECURITY_NOT_FOUND / DUPLICATE_SNAPSHOT_DATE。
 * - `securityTrades` / `cashFlows` 纯 insert 不去重（同日多笔合法）。
 * - `assetSnapshots` 按 (portfolioId, date) upsert；文件内同日期重复行 → DUPLICATE_SNAPSHOT_DATE（阻断该行，不阻断整体）。
 */

import { ImportType } from '@investment-tracker/shared';
import type { ImportRowError } from '@investment-tracker/shared';
import type { ParsedRow } from './csv-parser';

export type ImportFieldType = 'string' | 'date' | 'decimal' | 'enum';

export interface ImportField {
  key: string;
  required: boolean;
  type: ImportFieldType;
  allowed?: readonly string[];
  maxDecimals?: number;
}

export interface ImportSchema {
  type: ImportType;
  fields: ImportField[];
  /** securityTrades 关联 securities.code 的字段（存在性校验用） */
  securityCodeField?: string;
}

const SECURITY_TRADES_SCHEMA: ImportSchema = {
  type: ImportType.SECURITY_TRADES,
  securityCodeField: 'securityCode',
  fields: [
    { key: 'securityCode', required: true, type: 'string' },
    { key: 'date', required: true, type: 'date' },
    { key: 'side', required: true, type: 'enum', allowed: ['BUY_SEC', 'SELL_SEC'] },
    { key: 'quantity', required: true, type: 'decimal', maxDecimals: 6 },
    { key: 'costPrice', required: true, type: 'decimal', maxDecimals: 6 },
    { key: 'feeTotal', required: false, type: 'decimal', maxDecimals: 2 },
    { key: 'note', required: false, type: 'string' },
  ],
};

const CASH_FLOWS_SCHEMA: ImportSchema = {
  type: ImportType.CASH_FLOWS,
  fields: [
    { key: 'date', required: true, type: 'date' },
    { key: 'type', required: true, type: 'enum', allowed: ['BUY', 'SELL'] },
    { key: 'amount', required: true, type: 'decimal', maxDecimals: 2 },
    { key: 'note', required: false, type: 'string' },
  ],
};

const ASSET_SNAPSHOTS_SCHEMA: ImportSchema = {
  type: ImportType.ASSET_SNAPSHOTS,
  fields: [
    { key: 'date', required: true, type: 'date' },
    { key: 'totalAsset', required: true, type: 'decimal', maxDecimals: 2 },
    { key: 'marketValue', required: false, type: 'decimal', maxDecimals: 2 },
    { key: 'cashBalance', required: false, type: 'decimal', maxDecimals: 2 },
    { key: 'note', required: false, type: 'string' },
  ],
};

export const IMPORT_SCHEMAS: Record<ImportType, ImportSchema> = {
  [ImportType.SECURITY_TRADES]: SECURITY_TRADES_SCHEMA,
  [ImportType.CASH_FLOWS]: CASH_FLOWS_SCHEMA,
  [ImportType.ASSET_SNAPSHOTS]: ASSET_SNAPSHOTS_SCHEMA,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function isDateValid(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime());
}

/** 检查 Decimal 字符串的小数位（≤ maxDecimals） */
function decimalsOk(s: string, maxDecimals: number): boolean {
  const dotIdx = s.indexOf('.');
  if (dotIdx === -1) return true;
  return s.length - dotIdx - 1 <= maxDecimals;
}

/**
 * 校验单行。
 *
 * @param schema 导入 schema
 * @param row 解析后的行（含 rowNumber）
 * @param securityCodes 该组合已有 securities.code 集合（securityTrades 存在性校验）
 * @param seenDates assetSnapshots 已见日期集合（文件内重复 → DUPLICATE_SNAPSHOT_DATE）
 */
export function validateRow(
  schema: ImportSchema,
  row: ParsedRow,
  securityCodes: ReadonlySet<string>,
  seenDates: ReadonlySet<string>,
): ImportRowError[] {
  const errors: ImportRowError[] = [];
  const data = row.data;

  for (const field of schema.fields) {
    const value = data[field.key] ?? '';
    if (field.required && value === '') {
      errors.push({
        row: row.rowNumber,
        field: field.key,
        code: 'MISSING_REQUIRED_COLUMN',
        message: `缺少必填列「${field.key}」`,
      });
      continue;
    }
    if (value === '') continue; // 非必填空值放行

    switch (field.type) {
      case 'date':
        if (!isDateValid(value)) {
          errors.push({
            row: row.rowNumber,
            field: field.key,
            code: 'INVALID_DATE_FORMAT',
            message: `「${field.key}」不是有效日期（YYYY-MM-DD）`,
          });
        }
        break;
      case 'decimal':
        if (!DECIMAL_RE.test(value)) {
          errors.push({
            row: row.rowNumber,
            field: field.key,
            code: 'INVALID_DECIMAL_PRECISION',
            message: `「${field.key}」不是合法数字`,
          });
        } else if (
          field.maxDecimals !== undefined &&
          !decimalsOk(value, field.maxDecimals)
        ) {
          errors.push({
            row: row.rowNumber,
            field: field.key,
            code: 'INVALID_DECIMAL_PRECISION',
            message: `「${field.key}」最多 ${field.maxDecimals} 位小数`,
          });
        }
        break;
      case 'enum':
        if (field.allowed && !field.allowed.includes(value)) {
          errors.push({
            row: row.rowNumber,
            field: field.key,
            code: 'INVALID_ENUM_VALUE',
            message: `「${field.key}」只允许 ${field.allowed.join('/')}`,
          });
        }
        break;
      default:
        break;
    }
  }

  // 证券代码存在性（仅 securityTrades）
  if (schema.securityCodeField) {
    const code = data[schema.securityCodeField];
    if (code && !securityCodes.has(code)) {
      errors.push({
        row: row.rowNumber,
        field: schema.securityCodeField,
        code: 'SECURITY_NOT_FOUND',
        message: `标的不存在：${code}`,
      });
    }
  }

  // assetSnapshots 文件内重复日期
  if (schema.type === ImportType.ASSET_SNAPSHOTS) {
    const date = data.date;
    if (date && seenDates.has(date)) {
      errors.push({
        row: row.rowNumber,
        field: 'date',
        code: 'DUPLICATE_SNAPSHOT_DATE',
        message: `快照日期重复：${date}（同一天只保留一条）`,
      });
    }
  }

  return errors;
}

/** 该导入类型的日期字段名集合（XLSX 序列号转换用） */
export function dateFieldsOf(schema: ImportSchema): Set<string> {
  return new Set(
    schema.fields.filter((f) => f.type === 'date').map((f) => f.key),
  );
}
