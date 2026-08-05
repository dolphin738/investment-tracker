/**
 * csv/xlsx-parser.ts — XLSX / XLS → 对象数组（T05 · Excel 扩展）
 *
 * 与 CSV 约定同构：
 * - 第一行英文表头；跳过 `#` 开头行。
 * - 日期列：Excel 序列号（number）或 Date 对象 → `YYYY-MM-DD`（schema 指定 date 字段）。
 * - 其余单元格原样转为 string（Decimal 不转 number，防精度丢失）。
 */

import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import type { ParsedRow } from './csv-parser';

/** Excel 日期序列号 → YYYY-MM-DD（1900 日期系统，UTC 口径） */
function excelSerialToDateStr(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 单元格 → string；日期列做序列号转换 */
function cellToString(
  cell: unknown,
  isDateField: boolean,
): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    return isDateField ? cell.toISOString().split('T')[0] : cell.toISOString();
  }
  if (typeof cell === 'number' && isDateField) {
    return excelSerialToDateStr(cell);
  }
  return String(cell).trim();
}

/**
 * 解析 XLSX / XLS 文件 buffer → 行数组。
 *
 * @param buffer 文件内容
 * @param dateFields 该导入类型的日期字段名集合（Excel 序列号仅对这些列做日期转换）
 */
export function parseXlsx(
  buffer: Buffer,
  dateFields: ReadonlySet<string>,
): ParsedRow[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw new BadRequestException('Excel 解析失败，请检查文件格式');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new BadRequestException('Excel 文件没有工作表');
  }
  const sheet = workbook.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });
  if (aoa.length === 0) {
    throw new BadRequestException('Excel 文件为空');
  }

  const header = (aoa[0] ?? []).map((h) => String(h).trim());
  const out: ParsedRow[] = [];
  let dataRowNo = 0;
  for (let i = 1; i < aoa.length; i += 1) {
    const cells = aoa[i];
    if (!cells || cells.length === 0) continue;
    if (String(cells[0]).trim().startsWith('#')) continue; // 注释行
    dataRowNo += 1;
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (h) {
        const raw = cells[idx];
        obj[h] = cellToString(raw, dateFields.has(h));
      }
    });
    out.push({ rowNumber: dataRowNo, data: obj });
  }
  return out;
}
