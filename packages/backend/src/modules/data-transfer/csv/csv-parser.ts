/**
 * csv/csv-parser.ts — CSV → 对象数组（T05 · FLOW-P1-01）
 *
 * 封装 papaparse（前后端同库，行为一致），保留**数据行行号**（1 起，表头为第 0 行）。
 * - 去除 UTF-8 BOM；跳过空行与 `#` 开头行（第二行注释行约定）。
 * - 表头 trim；单元格 trim；缺失单元格为空串。
 * - 错误解析（引号不闭合等）抛 BadRequestException（INVALID_FILE_TYPE 由上层统一处理）。
 */

import { BadRequestException } from '@nestjs/common';
import * as Papa from 'papaparse';

export interface ParsedRow {
  /** 数据行号（1 起，不含表头 / 注释行） */
  rowNumber: number;
  /** 单元格原始值（统一 string） */
  data: Record<string, string>;
}

/** 解析 CSV 文本 → 行数组（第一行为表头） */
export function parseCsv(text: string): ParsedRow[] {
  // 去 BOM
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const result = Papa.parse<string[]>(clean, {
    skipEmptyLines: 'greedy',
  });

  const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.code === 'TooFewFields' || e.type === 'FieldMismatch');
  if (fatal || !result.data || result.data.length === 0) {
    throw new BadRequestException('CSV 解析失败，请检查文件格式');
  }

  const rows = result.data as string[][];
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const out: ParsedRow[] = [];
  let dataRowNo = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells || cells.length === 0) continue;
    if (String(cells[0]).trim().startsWith('#')) continue; // 注释行
    dataRowNo += 1;
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (h) obj[h] = String(cells[idx] ?? '').trim();
    });
    out.push({ rowNumber: dataRowNo, data: obj });
  }
  return out;
}
