<script setup lang="ts">
/**
 * modules/cashflow/components/TransactionsBalancePanel.vue — 现金余额页签面板
 *
 * 平移自 TransactionsPage.vue「现金余额」页签内容（纯位移，零行为变更）。
 * 纯展示组件：当前余额（门面 useLatestCashBalance 的查询结果）与筛选日期由门面
 * 以 props 传入，本组件不新建任何数据 hook；编辑/清除筛选通过 emit 回传门面。
 */

import { Info } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import CashBalanceHistory from '@/modules/cash-balance/components/CashBalanceHistory.vue';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { CashBalanceResponse } from '@/api/types';

defineProps<{
  /** 当前组合 ID（透传给 CashBalanceHistory；门面仅在确认已选组合的 v-else 分支渲染本组件，恒非空） */
  currentPortfolioId: string;
  /** 统一筛选器起始日期（约束余额变更历史） */
  filterStartDate: string;
  /** 统一筛选器结束日期（约束余额变更历史） */
  filterEndDate: string;
  /** 当前生效余额金额（门面 latestBalance 派生，CashBalanceResponse.amount 为字符串） */
  cashBalance: string | null | undefined;
  /** 门面 latestBalance.data.value（取 asOf 展示「自 X 起沿用」） */
  latestBalanceData: CashBalanceResponse | null | undefined;
  /** 偏好：金额千分位 */
  amountThousands: boolean;
  /** 偏好：金额缩写 */
  amountAbbrev: boolean;
}>();
const emit = defineEmits<{
  /** 编辑某条余额记录（直传门面 openEditBalance） */
  editBalance: [row: CashBalanceResponse];
  /** 清除筛选（直传门面 handleResetFilter） */
  clearFilter: [];
}>();

/** CashBalanceHistory onEdit 回调：转发为 emit（原门面 openEditBalance） */
function onEditBalance(row: CashBalanceResponse): void {
  emit('editBalance', row);
}
/** CashBalanceHistory onClearFilter 回调：转发为 emit（原门面 handleResetFilter） */
function onClearFilter(): void {
  emit('clearFilter');
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">现金余额（手工维护）</CardTitle>
      <CardDescription>
        维护组合现金余额，生效日起前向沿用；保存/删除均触发净值/XIRR 重算
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <!-- 当前余额展示行（CASH-P0-02 验收1）；录入入口已统一到页头按钮组 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-4">
        <div>
          <p class="text-xs text-muted-foreground">当前余额</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <template v-if="cashBalance !== undefined && cashBalance !== null">
              {{ formatCurrency(cashBalance, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </template>
            <template v-else>未维护，请点击右上角「录入现金余额」</template>
          </p>
          <p
            v-if="cashBalance !== undefined && cashBalance !== null && latestBalanceData"
            class="mt-0.5 text-xs text-muted-foreground"
          >
            自 {{ formatDate(latestBalanceData.asOf) }} 起沿用
          </p>
        </div>
      </div>

      <!-- CASH-P0-03 两条提示 -->
      <ul class="space-y-1.5 text-xs text-muted-foreground">
        <li class="flex items-start gap-1.5">
          <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>存取与证券买卖不会自动调整此值，请在操作后自行更新。</span>
        </li>
        <li class="flex items-start gap-1.5">
          <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>修改后自该日起的自动总资产记录将重新计算（您手工记录的日期会被跳过）。</span>
        </li>
      </ul>

      <!-- 余额变更历史（受顶部统一筛选器的日期范围约束，每条可编辑/删除） -->
      <div>
        <p class="mb-2 text-sm font-medium">余额变更历史</p>
        <CashBalanceHistory
          :portfolio-id="currentPortfolioId"
          :start-date="filterStartDate"
          :end-date="filterEndDate"
          :on-edit="onEditBalance"
          :on-clear-filter="onClearFilter"
        />
      </div>
    </CardContent>
  </Card>
</template>
