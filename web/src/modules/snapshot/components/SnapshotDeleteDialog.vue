<script setup lang="ts">
/**
 * modules/snapshot/components/SnapshotDeleteDialog.vue — 删除确认弹窗（平移自 SnapshotList.vue）
 *
 * 仅承载弹窗显隐（open）与确认（confirm）事件：删除目标由门面 deleting 驱动 open，
 * 确认动作交由门面执行 useDeleteSnapshot mutation（门面持有 mutation 单例与关闭时序
 * clearOnClose / handleDeleteDialogOpenChange）。pending（mutation 待定态）由门面下传，
 * 控制取消/确认禁用与确认按钮 spinner。纯位置拆分：文案与类名逐字节等价。
 */

import { Loader2 } from 'lucide-vue-next';
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
  /** 弹窗是否打开（由门面 Boolean(deleting) 驱动） */
  open: boolean;
  /** 删除 mutation 是否进行中（禁用按钮 + spinner） */
  pending: boolean;
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
  <!-- 删除确认（SNAP-P0-06 ⑤⑥：删除这条记录，事件日系统会重新生成自动值） -->
  <AlertDialog :open="open" @update:open="handleDialogOpenChange">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认删除该条资产记录？</AlertDialogTitle>
        <AlertDialogDescription>
          删除后，若该日为事件日（有交易/余额/价格数据）将自动重新生成系统计算值；
          否则该日记录将被移除，并从该日期起的净值与 XIRR 将被重算。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">
          取消
        </AlertDialogCancel>
        <AlertDialogAction
          :disabled="pending"
          class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          @click="emit('confirm')"
        >
          <Loader2
            v-if="pending"
            class="mr-2 h-4 w-4 animate-spin"
          />
          确认删除
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
