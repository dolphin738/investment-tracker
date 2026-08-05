/**
 * csv/csv-serializer.ts — 对象数组 → CSV（T05 · SET-P0-03）
 *
 * 约定（增量设计 §7.7）：
 * - UTF-8 + 前置 BOM `\uFEFF`（Excel 双击中文不乱码）。
 * - 第一行英文表头；第二行 `#` 注释行（导入端跳过 `#` 开头行）。
 * - Decimal 一律 string 原样输出（不科学计数、不丢精度）。
 * - `\r\n` 行尾；含逗号/引号/换行的值由 papaparse 自动双引号包裹转义。
 */

import * as Papa from 'papaparse';
import { ExportType } from '@investment-tracker/shared';
import type { ExportColumn } from './export-schemas';

/** 把一行对象按列定义规整为字符串数组（Date → YYYY-MM-DD / ISO；Decimal → string） */
export function rowToCells(
  row: Record<string, unknown>,
  columns: ExportColumn[],
): string[] {
  return columns.map((col) => {
    const raw = row[col.key];
    if (raw === null || raw === undefined) return '';
    if (raw instanceof Date) {
      // @db.Date 列 → YYYY-MM-DD；时间戳列 → ISO 8601
      return raw.toISOString().split('T')[0];
    }
    if (typeof raw === 'object' && 'toString' in (raw as object)) {
      const s = String(raw);
      return col.precision !== undefined ? trimDecimal(s, col.precision) : s;
    }
    return String(raw);
  });
}

/** 截断 Decimal 字符串到指定小数位（补零 / 截断，避免 Excel 科学计数） */
function trimDecimal(s: string, precision: number): string {
  const cleaned = s.trim();
  if (cleaned === '') return cleaned;
  const neg = cleaned.startsWith('-');
  const body = neg ? cleaned.slice(1) : cleaned;
  const dotIdx = body.indexOf('.');
  if (dotIdx === -1) {
    return `${neg ? '-' : ''}${body}.${'0'.repeat(precision)}`;
  }
  const intPart = body.slice(0, dotIdx);
  const fracPart = body.slice(dotIdx + 1).padEnd(precision, '0').slice(0, precision);
  return `${neg ? '-' : ''}${intPart}.${fracPart}`;
}

/**
 * 生成 CSV 字符串（UTF-8 + BOM）。
 *
 * @param rows 已按列规整的行数组（key → string）
 * @param columns 列定义（决定表头与取值顺序）
 * @param comment 第二行 `#` 注释内容
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, string>>,
  columns: ExportColumn[],
  comment = '导出文件：英文表头 + Decimal 字符串；修改后可通过「导入」回写',
): string {
  const lines: string[][] = [
    columns.map((c) => c.label),
    [`# ${comment}`],
    ...rows.map((r) => columns.map((c) => r[c.key] ?? '')),
  ];
  return `\uFEFF${Papa.unparse(lines, { newline: '\r\n' })}`;
}

/** 导出文件名（组合名-类型-YYYYMMDD.ext）；组合名做文件系统安全清洗 */
export function buildExportFilename(
  portfolioName: string,
  type: ExportType,
  dateStr: string,
  ext: 'csv' | 'xlsx',
): string {
  const safeName = portfolioName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'portfolio';
  return `${safeName}-${type}-${dateStr}.${ext}`;
}
