/**
 * features/data-transfer/export-panel.tsx — 数据导出面板（T05 · SET-P0-03）
 *
 * - 7 类数据多选（全不选提示）；格式 CSV / Excel（缺省 CSV）。
 * - 导出按钮：**串行逐个下载**（间隔 300ms 避免浏览器拦截多文件下载）。
 * - 文件名为 `{组合名}-{类型}-{YYYYMMDD}.{ext}`（与后端 Content-Disposition 一致）。
 *
 * 🔴 不引 zip：多类型导出前端串行触发多个下载。
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { EXPORT_TYPE_OPTIONS } from '@/lib/constants';
import { useExportData } from '@/hooks/use-data-transfer';
import { ExportType } from '@/api/types';

export interface ExportPanelProps {
  portfolioId: string;
  portfolioName: string;
  className?: string;
}

/** 串行下载间隔（浏览器防多文件拦截） */
const SERIAL_DELAY_MS = 300;

export function ExportPanel({
  portfolioId,
  portfolioName,
  className,
}: ExportPanelProps): JSX.Element {
  const [selected, setSelected] = useState<ExportType[]>([]);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const exportMutation = useExportData();

  const toggleType = (value: ExportType) => {
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  const handleExport = async () => {
    if (selected.length === 0) {
      toast.info('请先选择要导出的数据类型');
      return;
    }
    toast.info('开始导出，请稍候…');
    // 🔴 串行逐个下载（不引 zip）
    for (const type of selected) {
      try {
        await exportMutation.mutateAsync({ portfolioId, portfolioName, params: { type, format } });
      } catch {
        // api-client 已 toast；继续下一个
      }
      await new Promise((resolve) => setTimeout(resolve, SERIAL_DELAY_MS));
    }
    toast.success(`已导出 ${selected.length} 个文件`);
  };

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap gap-2">
        {EXPORT_TYPE_OPTIONS.map((opt) => {
          const checked = selected.includes(opt.value);
          return (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleType(opt.value)}
                className="h-3.5 w-3.5 accent-primary"
              />
              {opt.label}
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">格式</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as 'csv' | 'xlsx')}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="xlsx">Excel</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          onClick={handleExport}
          disabled={exportMutation.isPending}
          className="mt-5"
        >
          <Download className="mr-2 h-4 w-4" />
          {exportMutation.isPending ? '导出中…' : `导出（${selected.length}）`}
        </Button>
      </div>
    </div>
  );
}
