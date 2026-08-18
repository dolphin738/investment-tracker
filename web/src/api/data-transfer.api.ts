/**
 * api/data-transfer.api.ts — 数据导入导出 API（T05 · AL-042/079/080 + Excel 扩展）
 *
 * - exportData / downloadTemplate：文件下载（responseType:'blob'，后端不套信封）
 * - previewImport / commitImport：JSON 信封（code===0 解包后为业务数据）
 */

import { http } from '@/lib/api-client';
import type {
  ExportType,
  ImportType,
  ImportPreviewResult,
  ImportCommitResult,
} from '@/api/types';

export interface ExportParams {
  type: ExportType;
  format?: 'csv' | 'xlsx';
}

export interface TemplateParams {
  type: ImportType;
  format?: 'csv' | 'xlsx';
}

/** 导出数据（7 类，csv/xlsx）→ Blob（文件名由前端拼接，与后端 Content-Disposition 一致） */
export function exportData(
  portfolioId: string,
  params: ExportParams,
): Promise<Blob> {
  return http.get<Blob>(`/portfolios/${portfolioId}/export`, {
    params,
    responseType: 'blob',
  });
}

/** 下载导入模板（3 类，csv/xlsx）→ Blob */
export function downloadTemplate(params: TemplateParams): Promise<Blob> {
  return http.get<Blob>(`/data-transfer/template`, {
    params,
    responseType: 'blob',
  });
}

/** 导入预览（不落库）：multipart file + type */
export function previewImport(
  portfolioId: string,
  type: ImportType,
  file: File,
): Promise<ImportPreviewResult> {
  const fd = new FormData();
  fd.append('type', type);
  fd.append('file', file);
  return http.post<ImportPreviewResult>(
    `/portfolios/${portfolioId}/import/preview`,
    fd,
  );
}

/** 提交导入（type + token，单事务 + 单次重算） */
export function commitImport(
  portfolioId: string,
  payload: { type: ImportType; token: string },
): Promise<ImportCommitResult> {
  return http.post<ImportCommitResult>(
    `/portfolios/${portfolioId}/import/commit`,
    payload,
  );
}
