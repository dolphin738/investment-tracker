<script setup lang="ts">
/**
 * modules/admin/components/ScheduleTaskDeleteDialog.vue — 删除确认弹窗
 *
 * 从 SchedulePage 抽出：自带「待删除任务 id」状态与关闭时序，经模板 ref 由父级
 * （门面）调用 openConfirm(id) 打开、close() 收尾；确认后仅上抛 confirm 事件，
 * 由门面执行 deleteMut（mutation 单例留在门面，保证列表失效与提示统一）。
 */
import { ref } from 'vue';
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

/** 待删除任务 id（null 表示弹窗关闭） */
const deleteId = ref<string | null>(null);

const emit = defineEmits<{
  (e: 'confirm', id: string): void;
}>();

/** 打开确认弹窗（供父级经模板 ref 调用） */
function openConfirm(id: string): void {
  deleteId.value = id;
}

/** 关闭确认弹窗（供父级在删除成功后调用） */
function close(): void {
  deleteId.value = null;
}

function handleConfirmDelete(): void {
  if (deleteId.value) emit('confirm', deleteId.value);
}

/**
 * 删除确认弹窗关闭处理。
 *
 * reka-ui AlertDialogAction（内部 DialogClose）的关闭 handler 与用户 @click 按
 * [reka, user] 顺序合并执行：reka 先 onOpenChange(false) 再跑用户 handler。
 * 同步清空 deleteId 会让确认 handler 读不到删除目标，故延迟到微任务（对齐
 * ProviderInterfaces / PortfolioManagementCard 模式）。
 */
function handleDeleteDialogOpenChange(open: boolean): void {
  if (!open) {
    queueMicrotask(() => (deleteId.value = null));
  }
}

defineExpose({ openConfirm, close });
</script>

<template>
  <AlertDialog
    :open="deleteId !== null"
    @update:open="handleDeleteDialogOpenChange"
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认删除该定时任务？</AlertDialogTitle>
        <AlertDialogDescription>
          删除后不可恢复，且该任务将不再按计划执行。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction
          class="bg-red-500 hover:bg-red-600"
          @click="handleConfirmDelete"
        >
          删除
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
