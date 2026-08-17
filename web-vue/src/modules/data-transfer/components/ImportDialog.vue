<script setup lang="ts">
/**
 * modules/data-transfer/components/ImportDialog.vue — 数据导入对话框（T05 · FLOW-P1-01 / SET-P0-04）
 *
 * 平移自 React 版 features/data-transfer/import-dialog.tsx，行为契约一致：
 * 流程：选类型 → 选文件（.csv/.xlsx/.xls）→ 预览（前 10 行 + 全量错误，不落库）→ 确认提交。
 * - 导入前提示「先导出备份」（O-8 默认）。
 * - 提交成功 toast 透出「新增 N 行，更新 M 行；已重算 X 起 N 天」；失败行数单独提示。
 */

import { computed, ref, watch } from 'vue';
import { AlertTriangle, FileUp, Loader2, RefreshCw } from 'lucide-vue-next';
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
import { toast } from '@/composables/use-toast';
import { useImportCommit, useImportPreview } from '../composables/use-data-transfer';
import { ImportType } from '@/lib/types';
import type { ImportPreviewResult } from '@/lib/types';

const IMPORT_TYPE_OPTIONS: ReadonlyArray<{ value: ImportType; label: string }> = [
  { value: ImportType.SECURITY_TRADES, label: '证券买卖流水' },
  { value: ImportType.CASH_FLOWS, label: '出入金流水' },
  { value: ImportType.ASSET_SNAPSHOTS, label: '资产快照' },
];

const props = defineProps<{
  portfolioId: string;
  open: boolean;
}>();

const emit = defineEmits<{
  openChange: [open: boolean];
}>();

const type = ref<ImportType>(ImportType.CASH_FLOWS);
const file = ref<File | null>(null);
const preview = ref<ImportPreviewResult | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const previewMutation = useImportPreview();
const commitMutation = useImportCommit();

function reset(): void {
  file.value = null;
  preview.value = null;
  if (fileInputRef.value) fileInputRef.value.value = '';
}

function handleClose(next: boolean): void {
  if (!next) reset();
  emit('openChange', next);
}

function handleTypeChange(value: ImportType): void {
  type.value = value;
  reset();
}

function handleFileChange(e: Event): void {
  const target = e.target as HTMLInputElement;
  file.value = target.files?.[0] ?? null;
  preview.value = null;
}

function handlePreview(): void {
  if (!file.value) {
    toast.info('请先选择要导入的文件');
    return;
  }
  previewMutation.mutate(
    { portfolioId: props.portfolioId, type: type.value, file: file.value },
    {
      onSuccess: (result) => {
        preview.value = result;
      },
    },
  );
}

function handleCommit(): void {
  if (!preview.value) return;
  commitMutation.mutate(
    { portfolioId: props.portfolioId, payload: { type: type.value, token: preview.value.token } },
    {
      onSuccess: () => {
        handleClose(false);
      },
    },
  );
}

const canCommit = computed(
  () =>
    Boolean(preview.value && preview.value.validRows > 0 && !commitMutation.isPending.value),
);

// 打开时重置为初始态（对齐 React 版 useEffect：每次打开回到默认类型）
watch(
  () => props.open,
  (open) => {
    if (open) {
      type.value = ImportType.CASH_FLOWS;
      reset();
    }
  },
);
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => handleClose(v)">
    <DialogContent class="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>导入数据</DialogTitle>
        <DialogDescription>
          支持 .csv / .xlsx / .xls；预览通过后提交，全流程仅触发一次净值重算。
        </DialogDescription>
      </DialogHeader>

      <!-- O-8：导入前备份提示 -->
      <div class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          建议先在上方「导出」备份当前数据；证券买卖 / 出入金导入为追加写入，资产快照按日期覆盖。
        </span>
      </div>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label class="text-xs">导入类型</Label>
          <div class="flex flex-wrap gap-2">
            <Button
              v-for="opt in IMPORT_TYPE_OPTIONS"
              :key="opt.value"
              type="button"
              size="sm"
              :variant="type === opt.value ? 'default' : 'outline'"
              @click="handleTypeChange(opt.value)"
            >
              {{ opt.label }}
            </Button>
          </div>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs" for="import-file">
            选择文件（.csv / .xlsx / .xls，≤5MB，≤10000 行）
          </Label>
          <div class="flex items-center gap-2">
            <Input
              id="import-file"
              ref="fileInputRef"
              type="file"
              accept=".csv,.xlsx,.xls"
              class="h-9 flex-1"
              @change="handleFileChange"
            />
            <Button size="sm" :disabled="previewMutation.isPending.value" @click="handlePreview">
              <Loader2 v-if="previewMutation.isPending.value" class="mr-1 h-3.5 w-3.5 animate-spin" />
              <FileUp v-else class="mr-1 h-3.5 w-3.5" />
              预览
            </Button>
          </div>
        </div>

        <!-- 预览结果 -->
        <div v-if="preview" class="space-y-2">
          <p class="text-xs text-muted-foreground">
            共 {{ preview.totalRows }} 行，有效 {{ preview.validRows }} 行，
            错误 {{ preview.errors.length }} 条
            <span v-if="preview.minDate">，最早 {{ preview.minDate }}</span>
          </p>

          <div v-if="preview.sample.length > 0" class="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    v-for="k in Object.keys(preview.sample[0])"
                    :key="k"
                    class="whitespace-nowrap text-xs"
                  >
                    {{ k }}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(row, i) in preview.sample" :key="i">
                  <TableCell
                    v-for="(v, j) in Object.values(row)"
                    :key="j"
                    class="whitespace-nowrap text-xs"
                  >
                    {{ v }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div v-if="preview.errors.length > 0" class="max-h-40 overflow-y-auto rounded-md border border-red-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-[60px] text-xs">行</TableHead>
                  <TableHead class="w-[110px] text-xs">字段</TableHead>
                  <TableHead class="w-[140px] text-xs">原因</TableHead>
                  <TableHead class="text-xs">说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(err, i) in preview.errors.slice(0, 50)" :key="i">
                  <TableCell class="text-xs">{{ err.row }}</TableCell>
                  <TableCell class="text-xs">{{ err.field ?? '-' }}</TableCell>
                  <TableCell class="text-xs">{{ err.code }}</TableCell>
                  <TableCell class="text-xs">{{ err.message }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="handleClose(false)">
          取消
        </Button>
        <Button
          v-if="preview"
          size="sm"
          variant="ghost"
          @click="
            preview = null;
            previewMutation.reset();
          "
        >
          <RefreshCw class="mr-1 h-3.5 w-3.5" />
          重新预览
        </Button>
        <Button size="sm" :disabled="!canCommit" @click="handleCommit">
          <Loader2 v-if="commitMutation.isPending.value" class="mr-1 h-3.5 w-3.5 animate-spin" />
          确认导入
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>