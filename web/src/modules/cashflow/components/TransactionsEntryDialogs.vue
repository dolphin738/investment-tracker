<script setup lang="ts">
/**
 * modules/cashflow/components/TransactionsEntryDialogs.vue — 录入弹窗组
 *
 * 平移自 TransactionsPage.vue 的两个录入弹窗（纯位移，零行为变更）：
 * 「录入/编辑出入金」与「录入/编辑现金余额」。弹窗开关状态、编辑行与
 * on-success 回调均由门面持有，本组件纯展示转发，通过 emit 回传开关变更。
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import CashflowForm from './CashflowForm.vue';
import CashBalanceForm from '@/modules/cash-balance/components/CashBalanceForm.vue';
import { ENTRY_BUTTON_LABELS } from '@/constants/entry-button-labels';
import type { CashBalanceResponse } from '@/api/types';

defineProps<{
  /** 出入金录入弹窗开关 */
  cashflowOpen: boolean;
  /** 现金余额录入/编辑弹窗开关 */
  balanceOpen: boolean;
  /** 现金余额编辑行（null 即新增） */
  editingBalance: CashBalanceResponse | null;
  /** 门面仅在确认已选组合的 v-else 分支渲染本组件，恒非空 */
  currentPortfolioId: string;
  /** 出入金表单保存成功回调（门面持有：关弹窗） */
  onCashflowSuccess: () => void;
  /** 现金余额表单保存成功回调（门面持有：关弹窗并清空编辑行） */
  onBalanceSuccess: () => void;
}>();
const emit = defineEmits<{
  /** 出入金弹窗开关变更（原 @update:open，门面写回 open） */
  cashflowOpenChange: [open: boolean];
  /** 现金余额弹窗开关变更（原 @update:open；关闭时门面清空 editingBalance） */
  balanceOpenChange: [open: boolean];
}>();
</script>

<template>
  <!-- 录入/编辑出入金弹窗 -->
  <Dialog
    :open="cashflowOpen"
    @update:open="(o) => emit('cashflowOpenChange', o)"
  >
    <DialogContent class="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ ENTRY_BUTTON_LABELS.cashFlow }}</DialogTitle>
      </DialogHeader>
      <CashflowForm
        :portfolio-id="currentPortfolioId"
        :on-success="onCashflowSuccess"
      />
    </DialogContent>
  </Dialog>

  <!-- 录入/编辑现金余额弹窗（新增与编辑复用同一表单组件） -->
  <Dialog
    :open="balanceOpen"
    @update:open="(o) => emit('balanceOpenChange', o)"
  >
    <DialogContent class="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {{ editingBalance ? '编辑现金余额' : ENTRY_BUTTON_LABELS.cashBalance }}
        </DialogTitle>
      </DialogHeader>
      <CashBalanceForm
        :portfolio-id="currentPortfolioId"
        :balance="editingBalance"
        :on-success="onBalanceSuccess"
      />
    </DialogContent>
  </Dialog>
</template>
