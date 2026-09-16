<script setup lang="ts">
/**
 * modules/admin/components/LogCenterDeleteDialog.vue — 日志批量/单行删除确认弹窗
 *
 * 从 LogCenterPage 抽出：仅承载弹窗显隐（open）与删除确认（confirm）事件，以及描述文案
 * 所需的 confirmPayload / total / pending（mutation 待定态由门面下传）。确认动作交由门面
 * 执行 useDeleteLogs mutation（门面持有 mutation 单例，统一失效列表缓存与 toast 提示）。
 * 纯位置性拆分，零行为变更。
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
import type { LogDeleteParams } from '@/api/log-center.api';

const props = defineProps<{
  /** 弹窗是否打开（由门面 confirmOpen 驱动） */
  open: boolean;
  /** 待删除参数（批量 all / 单行 ids） */
  confirmPayload: LogDeleteParams | null;
  /** 当前筛选结果总数（描述文案） */
  total: number;
  /** 删除 mutation 是否进行中（禁用按钮 + 文案切换） */
  pending: boolean;
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'update:open', open: boolean): void;
}>();

function handleDialogOpenChange(open: boolean): void {
  emit('update:open', open);
}
</script>

<template>
  <AlertDialog :open="open" @update:open="handleDialogOpenChange">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>删除日志</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="confirmPayload?.all">
            将删除当前筛选条件下全部 {{ total }} 条日志（跨所有页）；其中未读通知会被跳过。
          </template>
          <template v-else>
            将删除 {{ confirmPayload?.ids?.length ?? 0 }} 条日志；其中未读通知会被跳过。
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">取消</AlertDialogCancel>
        <AlertDialogAction
          class="bg-red-600 hover:bg-red-700"
          :disabled="pending"
          @click="emit('confirm')"
        >
          {{ pending ? '删除中…' : '删除' }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
