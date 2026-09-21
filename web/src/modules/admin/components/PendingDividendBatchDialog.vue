<script setup lang="ts">
/**
 * modules/admin/components/PendingDividendBatchDialog.vue — 待划分分红批量确认弹窗
 *
 * 两种模式共用（设计 §5.3.8）：
 * - assign（采纳建议 → 写分红主表）：正文列**前 3 笔**预览 + 跳过无候选行数；可事后「重新划分」撤销。
 * - ignore（忽略 → 不写主表、不可撤销）：正文明确「不会写入分红主表」。
 * 确认动作经 confirm 上抛，由门面执行对应 mutation。纯展示，无副作用。
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const props = defineProps<{
  /** 是否打开 */
  open: boolean;
  /** 批量模式：采纳建议（写主表）/ 忽略（不写主表） */
  mode: 'assign' | 'ignore';
  /** 采纳建议将覆盖的笔数（有建议候选的选中行） */
  adoptCount: number;
  /** 已选笔数（忽略模式文案用） */
  selectedCount: number;
  /** 被跳过的无候选行数 */
  skipped: number;
  /** 采纳建议预览（前 3 笔，形如「600519 2022Q4 特别分配」） */
  preview: string[];
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'update:open', open: boolean): void;
}>();
</script>

<template>
  <AlertDialog :open="props.open" @update:open="(o: boolean) => emit('update:open', o)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{
            props.mode === 'assign'
              ? '确认采纳建议并写入分红主表？'
              : '确认忽略这些待划分分红？'
          }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="props.mode === 'assign'">
            将为 {{ props.adoptCount }} 笔待划分分红写入分红主表（报告期取前端建议值，可事后「重新划分」撤销）：
            <span class="mt-1 block font-mono">{{ props.preview.join('；') }}</span>
            <span v-if="props.skipped > 0" class="mt-1 block">
              已跳过 {{ props.skipped }} 笔无候选行。
            </span>
          </template>
          <template v-else>
            将忽略 {{ props.selectedCount }} 笔待划分分红；<span class="font-medium">不会写入分红主表</span>，
            且不可撤销（对应的派息信息将永久丢失）。
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction
          class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          @click="emit('confirm')"
        >
          确认
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
