<script setup lang="ts">
/**
 * components/DividendDeleteDialog.vue — 分红删除确认弹窗（平移自 DividendList.vue）
 *
 * 仅承载弹窗显隐（open）与确认（confirm）事件：删除目标由门面 deleting 驱动 open，
 * 确认动作交由门面执行 useDeleteDividend mutation（门面持有 mutation 单例与关闭时序
 * handleDeleteDialogOpenChange）。纯位置拆分：文案与类名逐字节等价。
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

defineProps<{
  /** 弹窗是否打开（由门面 Boolean(deleting) 驱动） */
  open: boolean;
}>();

const emit = defineEmits<{
  /** 点击确认删除（交由门面 handleConfirmDelete 执行 mutation） */
  confirm: [];
  /** 弹窗开关变化（交由门面 handleDeleteDialogOpenChange 维护关闭时序） */
  'update:open': [open: boolean];
}>();

function handleDialogOpenChange(o: boolean): void {
  emit('update:open', o);
}
</script>

<template>
  <AlertDialog :open="open" @update:open="handleDialogOpenChange">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认删除分红记录？</AlertDialogTitle>
        <AlertDialogDescription>
          删除后不可恢复。该记录不参与收益计算，删除不会影响净值与 XIRR。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction @click="emit('confirm')">删除</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
