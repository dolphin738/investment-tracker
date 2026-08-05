/**
 * csv/xlsx-serializer.ts — 对象数组 → XLSX buffer（T05 · Excel 扩展）
 *
 * 与 CSV 导出列结构**完全一致**（不含额外 sheet 汇总）：
 * 第一行英文表头 + 第二行 `#` 注释行（sheet 单元格文本）+ 数据行。
 * Decimal 一律 string 原样写入（不做数值化，防精度丢失）。
 */

import * as XLSX from 'xlsx';
import type { ExportColumn } from './export-schemas';

/** 生成 XLSX buffer（单个 sheet，名为 data） */
export function toXlsx(
  rows: ReadonlyArray<Record<string, string>>,
  columns: ExportColumn[],
  comment = '导出文件：英文表头 + Decimal 字符串；修改后可通过「导入」回写',
): Buffer {
  const headerCells = columns.map((c) => c.label);
  const commentCells = [`# ${comment}`];
  const aoa: unknown[][] = [
    headerCells,
    commentCells,
    ...rows.map((r) => columns.map((c) => r[c.key] ?? '')),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'data');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** XLSX 文件 Content-Type */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
