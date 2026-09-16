<script setup lang="ts">
/**
 * modules/snapshot/components/SnapshotResetDialog.vue — 重置确认弹窗（平移自 SnapshotList.vue）
 *
 * 仅承载弹窗显隐（open）与确认（confirm）事件：重置目标由门面 resetting 经 target 下传
 * （描述文案展示该日日期与系统自动值），确认动作交由门面执行 useResetSnapshot mutation
 * （门面持有 mutation 单例与关闭时序 clearOnClose / handleResetDialogOpenChange）。
 * pending（mutation 待定态）由门面下传。systemValOf / 金额格式化随文案一并平移。
 * 纯位置拆分：文案与类名逐字节等价。
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
import {
  formatCurrency,
  formatDate,
  type FormatCurrencyOptions,
} from '@/lib/utils';
import type { SnapshotResponse } from '@/api/types';

const props = defineProps<{
  /** 弹窗是否打开（由门面 Boolean(resetting) 驱动） */
  open: boolean;
  /** 待重置目标行（null = 弹窗关闭中，描述走兜底文案） */
  target: SnapshotResponse | null;
  /** 重置 mutation 是否进行中（禁用按钮 + spinner） */
  pending: boolean;
  /** 金额格式偏好（千分位 / 缩写，门面自 preference store 读取） */
  fmtOpts: FormatCurrencyOptions;
}>();

const emit = defineEmits<{
  /** 点击确认重置（交由门面 handleConfirmReset 执行 mutation） */
  confirm: [];
  /** 弹窗开关变化（交由门面 handleResetDialogOpenChange 维护关闭时序） */
  'update:open': [open: boolean];
}>();

/** 系统自动计算值（AL-054 · Q-1甲）：直接读列表行内 derivedTotalAsset（后端已实时回填） */
function systemValOf(s: SnapshotResponse): number | null {
  if (s.derivedTotalAsset == null) return null;
  const n = Number(s.derivedTotalAsset);
  return Number.isFinite(n) ? n : null;
}

function handleDialogOpenChange(o: boolean): void {
  emit('update:open', o);
}
</script>

<template>
  <!-- 重置确认（SNAP-P0-07：撤销手工修改，恢复系统计算值 + 将恢复值展示） -->
  <AlertDialog :open="open" @update:open="handleDialogOpenChange">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>重置为系统自动计算值？</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="target">
            {{ formatDate(target.date) }} 的手工记录将被系统自动计算值取代，无法撤销。
            <template v-if="systemValOf(target) !== null">
              将恢复为系统自动计算值
              {{ formatCurrency(systemValOf(target)!, 2, fmtOpts) }}。
            </template>
          </template>
          <template v-else>
            手工记录将被系统自动计算值取代，无法撤销。
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">
          取消
        </AlertDialogCancel>
        <AlertDialogAction
          :disabled="pending"
          @click="emit('confirm')"
        >
          <Loader2
            v-if="pending"
            class="mr-2 h-4 w-4 animate-spin"
          />
          确认重置
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
