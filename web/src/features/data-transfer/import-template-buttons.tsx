/**
 * features/data-transfer/import-template-buttons.tsx — 3 类导入模板下载按钮（T05 · SET-P0-04）
 *
 * CSV / XLSX 双格式：默认 CSV，可切 Excel。
 */

import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDownloadTemplate } from '@/hooks/use-data-transfer';
import { ImportType } from '@/api/types';

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: ImportType; label: string }> = [
  { value: ImportType.SECURITY_TRADES, label: '证券买卖' },
  { value: ImportType.CASH_FLOWS, label: '出入金' },
  { value: ImportType.ASSET_SNAPSHOTS, label: '总资产记录' },
];

export function ImportTemplateButtons(): JSX.Element {
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const templateMutation = useDownloadTemplate();

  const handleDownload = (type: ImportType) => {
    templateMutation.mutate({ type, format });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {TEMPLATE_OPTIONS.map((opt) => (
        <Button
          key={opt.value}
          variant="outline"
          size="sm"
          onClick={() => handleDownload(opt.value)}
          disabled={templateMutation.isPending}
        >
          <FileDown className="mr-1 h-3.5 w-3.5" />
          模板：{opt.label}
        </Button>
      ))}
      <Select
        value={format}
        onValueChange={(v) => setFormat(v as 'csv' | 'xlsx')}
      >
        <SelectTrigger className="w-[100px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="csv">CSV</SelectItem>
          <SelectItem value="xlsx">Excel</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
