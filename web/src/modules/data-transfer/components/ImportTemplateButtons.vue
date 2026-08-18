<script setup lang="ts">
/**
 * modules/data-transfer/components/ImportTemplateButtons.vue — 3 类导入模板下载按钮（T05 · SET-P0-04）
 *
 * 平移自 React 版 features/data-transfer/import-template-buttons.tsx，行为契约一致：
 * CSV / XLSX 双格式：默认 CSV，可切 Excel。
 */

import { ref } from 'vue';
import { FileDown } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDownloadTemplate } from '../composables/use-data-transfer';
import { ImportType } from '@/lib/types';

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: ImportType; label: string }> = [
  { value: ImportType.SECURITY_TRADES, label: '证券买卖' },
  { value: ImportType.CASH_FLOWS, label: '出入金' },
  { value: ImportType.ASSET_SNAPSHOTS, label: '总资产记录' },
];

const format = ref<'csv' | 'xlsx'>('csv');
const templateMutation = useDownloadTemplate();

function handleDownload(type: ImportType): void {
  templateMutation.mutate({ type, format: format.value });
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <Button
      v-for="opt in TEMPLATE_OPTIONS"
      :key="opt.value"
      variant="outline"
      size="sm"
      :disabled="templateMutation.isPending.value"
      @click="handleDownload(opt.value)"
    >
      <FileDown class="mr-1 h-3.5 w-3.5" />
      模板：{{ opt.label }}
    </Button>
    <Select v-model="format">
      <SelectTrigger class="w-[100px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="csv">CSV</SelectItem>
        <SelectItem value="xlsx">Excel</SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>