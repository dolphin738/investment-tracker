/**
 * features/data-transfer/import-dialog.tsx — 数据导入对话框（T05 · FLOW-P1-01 / SET-P0-04）
 *
 * 流程：选类型 → 选文件（.csv/.xlsx/.xls）→ 预览（前 10 行 + 全量错误，**不落库**）→ 确认提交。
 * - 导入前提示「先导出备份」（O-8 默认）。
 * - 提交成功 toast 透出「新增 N 行，更新 M 行；已重算 X 起 N 天」；失败行数单独提示。
 */

import { useRef, useState } from 'react';
import { AlertTriangle, FileUp, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { useImportCommit, useImportPreview } from '@/hooks/use-data-transfer';
import { ImportType } from '@/api/types';
import type { ImportPreviewResult } from '@/api/types';

const IMPORT_TYPE_OPTIONS: ReadonlyArray<{ value: ImportType; label: string }> = [
  { value: ImportType.SECURITY_TRADES, label: '证券买卖流水' },
  { value: ImportType.CASH_FLOWS, label: '出入金流水' },
  { value: ImportType.ASSET_SNAPSHOTS, label: '资产快照' },
];

export interface ImportDialogProps {
  portfolioId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportDialog({
  portfolioId,
  open,
  onOpenChange,
}: ImportDialogProps): JSX.Element {
  const [type, setType] = useState<ImportType>(ImportType.CASH_FLOWS);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewMutation = useImportPreview();
  const commitMutation = useImportCommit();

  const reset = () => {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleTypeChange = (value: ImportType) => {
    setType(value);
    reset();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreview(null);
  };

  const handlePreview = () => {
    if (!file) {
      toast.info('请先选择要导入的文件');
      return;
    }
    previewMutation.mutate(
      { portfolioId, type, file },
      {
        onSuccess: (result) => setPreview(result),
      },
    );
  };

  const handleCommit = () => {
    if (!preview) return;
    commitMutation.mutate(
      { portfolioId, payload: { type, token: preview.token } },
      {
        onSuccess: () => {
          handleClose(false);
        },
      },
    );
  };

  const canCommit = Boolean(preview && preview.validRows > 0 && !commitMutation.isPending);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入数据</DialogTitle>
          <DialogDescription>
            支持 .csv / .xlsx / .xls；预览通过后提交，全流程仅触发一次净值重算。
          </DialogDescription>
        </DialogHeader>

        {/* O-8：导入前备份提示 */}
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            建议先在上方「导出」备份当前数据；证券买卖 / 出入金导入为追加写入，资产快照按日期覆盖。
          </span>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">导入类型</Label>
            <div className="flex flex-wrap gap-2">
              {IMPORT_TYPE_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  size="sm"
                  variant={type === opt.value ? 'default' : 'outline'}
                  onClick={() => handleTypeChange(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="import-file">
              选择文件（.csv / .xlsx / .xls，≤5MB，≤10000 行）
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="import-file"
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileChange}
                className="h-9 flex-1"
              />
              <Button
                size="sm"
                onClick={handlePreview}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileUp className="mr-1 h-3.5 w-3.5" />
                )}
                预览
              </Button>
            </div>
          </div>

          {/* 预览结果 */}
          {preview && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                共 {preview.totalRows} 行，有效 {preview.validRows} 行，
                错误 {preview.errors.length} 条
                {preview.minDate ? `，最早 ${preview.minDate}` : ''}
              </p>

              {preview.sample.length > 0 && (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {Object.keys(preview.sample[0]).map((k) => (
                          <TableHead key={k} className="whitespace-nowrap text-xs">
                            {k}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.sample.map((row, i) => (
                        <TableRow key={i}>
                          {Object.values(row).map((v, j) => (
                            <TableCell key={j} className="whitespace-nowrap text-xs">
                              {v}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {preview.errors.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-red-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[60px] text-xs">行</TableHead>
                        <TableHead className="w-[110px] text-xs">字段</TableHead>
                        <TableHead className="w-[140px] text-xs">原因</TableHead>
                        <TableHead className="text-xs">说明</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.errors.slice(0, 50).map((err, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{err.row}</TableCell>
                          <TableCell className="text-xs">{err.field ?? '-'}</TableCell>
                          <TableCell className="text-xs">{err.code}</TableCell>
                          <TableCell className="text-xs">{err.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
            取消
          </Button>
          {preview && (
            <Button
              size="sm"
              onClick={() => {
                setPreview(null);
                previewMutation.reset();
              }}
              variant="ghost"
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              重新预览
            </Button>
          )}
          <Button size="sm" onClick={handleCommit} disabled={!canCommit}>
            {commitMutation.isPending && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            确认导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
