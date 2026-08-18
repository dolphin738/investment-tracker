<script setup lang="ts">
/**
 * modules/data-transfer/components/ExportPanel.vue — 数据导出面板（T05 · SET-P0-03）
 *
 * 平移自 React 版 features/data-transfer/export-panel.tsx，行为契约一致：
 * - 7 类数据多选（全不选提示）；格式 CSV / Excel（缺省 CSV）。
 * - 导出按钮：串行逐个下载（间隔 300ms 避免浏览器拦截多文件下载）。
 * - 文件名为 `{组合名}-{类型}-{YYYYMMDD}.{ext}`（与后端 Content-Disposition 一致）。
 *
 * 不引 zip：多类型导出前端串行触发多个下载。
 */

import { ref } from 'vue';
import { Download } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/composables/use-toast';
import { EXPORT_TYPE_OPTIONS } from '@/lib/constants';
import { useExportData } from '../composables/use-data-transfer';
import type { ExportType } from '@/lib/types';

const props = defineProps<{
  portfolioId: string;
  portfolioName: string;
  className?: string;
}>();

/** 串行下载间隔（浏览器防多文件拦截） */
const SERIAL_DELAY_MS = 300;

const selected = ref<ExportType[]>([]);
const format = ref<'csv' | 'xlsx'>('csv');
const exportMutation = useExportData();

function toggleType(value: ExportType): void {
  const idx = selected.value.indexOf(value);
  if (idx >= 0) {
    selected.value = selected.value.filter((v) => v !== value);
  } else {
    selected.value = [...selected.value, value];
  }
}

async function handleExport(): Promise<void> {
  if (selected.value.length === 0) {
    toast.info('请先选择要导出的数据类型');
    return;
  }
  toast.info('开始导出，请稍候…');
  // 串行逐个下载（不引 zip）
  for (const type of selected.value) {
    try {
      await exportMutation.mutateAsync({
        portfolioId: props.portfolioId,
        portfolioName: props.portfolioName,
        params: { type, format: format.value },
      });
    } catch {
      // api-client 已 toast；继续下一个
    }
    await new Promise((resolve) => setTimeout(resolve, SERIAL_DELAY_MS));
  }
  toast.success(`已导出 ${selected.value.length} 个文件`);
}
</script>

<template>
  <div :class="props.className">
    <div class="mb-2 flex flex-wrap gap-2">
      <label
        v-for="opt in EXPORT_TYPE_OPTIONS"
        :key="opt.value"
        class="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
      >
        <input
          type="checkbox"
          :checked="selected.includes(opt.value)"
          :value="opt.value"
          class="h-3.5 w-3.5 accent-primary"
          @change="toggleType(opt.value)"
        />
        {{ opt.label }}
      </label>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">格式</Label>
        <Select v-model="format">
          <SelectTrigger class="w-[120px]">
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
        :disabled="exportMutation.isPending.value"
        class="mt-5"
        @click="handleExport"
      >
        <Download class="mr-2 h-4 w-4" />
        {{ exportMutation.isPending.value ? '导出中…' : `导出（${selected.length}）` }}
      </Button>
    </div>
  </div>
</template>