/**
 * hooks/use-data-transfer.ts — 数据导入导出 TanStack Query hooks（T05）
 *
 * - useExportData：导出 → 触发下载
 * - useDownloadTemplate：下载模板
 * - useImportPreview：预览（不落库）
 * - useImportCommit：提交 → 成功后 invalidate 六组相关查询（T05 验收 7）
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  commitImport as commitApi,
  downloadTemplate as templateApi,
  exportData as exportApi,
  previewImport as previewApi,
  type ExportParams,
  type TemplateParams,
} from '@/api/data-transfer.api';
import { downloadBlob, sanitizeFilename } from '@/features/data-transfer/csv-download';
import { todayInAppTzIso } from '@/lib/constants';
import type { ImportType } from '@/api/types';

/** 导入 commit 后影响的 query key 前缀（T05 验收 7） */
const COMMIT_AFFECTED_KEYS = [
  ['holdings'],
  ['overview'],
  ['nav'],
  ['xirr'],
  ['transactions'],
  ['snapshots'],
  ['cash-balances'],
] as const;

/** 导出（触发下载） */
export function useExportData() {
  return useMutation({
    mutationFn: ({
      portfolioId,
      portfolioName,
      params,
    }: {
      portfolioId: string;
      portfolioName: string;
      params: ExportParams;
    }) =>
      exportApi(portfolioId, params).then((blob) => {
        const ext = params.format ?? 'csv';
        const dateStr = todayInAppTzIso();
        const filename = `${sanitizeFilename(portfolioName)}-${params.type}-${dateStr}.${ext}`;
        downloadBlob(blob, filename);
      }),
  });
}

/** 下载导入模板 */
export function useDownloadTemplate() {
  return useMutation({
    mutationFn: (params: TemplateParams) =>
      templateApi(params).then((blob) => {
        const ext = params.format ?? 'csv';
        const dateStr = todayInAppTzIso();
        downloadBlob(blob, `${params.type}-template-${dateStr}.${ext}`);
      }),
  });
}

/** 导入预览（不落库） */
export function useImportPreview() {
  return useMutation({
    mutationFn: ({
      portfolioId,
      type,
      file,
    }: {
      portfolioId: string;
      type: ImportType;
      file: File;
    }) => previewApi(portfolioId, type, file),
    onError: () => {
      // 错误 toast 已由 api-client 统一弹出，这里不重复提示
    },
  });
}

/** 提交导入（单事务 + 单次重算；成功后 invalidate 六组） */
export function useImportCommit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: { type: ImportType; token: string };
    }) => commitApi(portfolioId, payload),
    onSuccess: (result) => {
      const recalcText = result.recalculated
        ? `；已重算 ${result.recalculated.fromDate} 起 ${result.recalculated.recalculatedDays} 天`
        : '';
      toast.success(`导入完成：新增 ${result.inserted} 行，更新 ${result.updated} 行${recalcText}`);
      if (result.failed.length > 0) {
        toast.warning(`其中 ${result.failed.length} 行写入失败`);
      }
      COMMIT_AFFECTED_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}
