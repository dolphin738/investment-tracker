<script setup lang="ts">
/**
 * modules/cash-balance/components/CashBalanceHistory.vue — 现金余额变更历史表格
 * （CASH-P1-01 / AL-046）
 *
 * 平移自 React 版 features/cashflow/cash-balance-history.tsx，行为契约一致。
 *
 * 出入金页改版后的定位：作为「现金余额」页签的主列表（不再是折叠器），
 * 版式对齐持仓页「买卖明细」——上方当前余额、下方变更历史。
 *
 * - 日期范围受控：由页面顶部统一筛选器下发（本组件不再自绘筛选栏），
 *   与「出入金流水」共用同一份日期条件。范围变化时自动回到第 1 页。
 * - 按 asOf 倒序分页列出（生效日 / 金额 / 备注 / 更新时间），pageSize 20。
 * - 每行可编辑（交回父级用统一录入弹窗承载，新增/编辑复用同一表单）
 *   与删除（二次确认；删除触发后端 recalculateRange 级联重算）。
 * - 删除成功 toast 由 use-cash-balances 统一产出「已重算（自 YYYY-MM-DD 起）」；
 *   删除失败则保持确认框打开并就地显示原因（不吞错误，不重复 toast）。
 * - 成功后 invalidate：cash-balances / overview / nav / xirr / snapshots / holdings
 *   （由 useDeleteCashBalance 统一处理，列表随之自动刷新）。
 *
 * 注意（Vue 版实现差异说明）：reka-ui 的 AlertDialogAction 点击后无条件关闭对话框
 * （不检查 defaultPrevented，与 Radix React 不同），因此「失败保持打开」改为
 * 受控 open + 确认请求进行中拒绝关闭请求的方案，外部行为与 React 版一致。
 */

import { computed, ref, watch } from 'vue';
import { AlertCircle, Loader2, Pencil, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  useCashBalances,
  useDeleteCashBalance,
} from '../composables/use-cash-balances';
import { usePreferenceStore } from '@/stores/preference.store';
import { resolveApiErrorMessage } from '@/lib/api-error-message';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { CashBalanceResponse } from '@/api/types';

/** 历史分页大小（CASH-P1-01） */
const HISTORY_PAGE_SIZE = 20;

const props = withDefaults(
  defineProps<{
    portfolioId: string;
    /** 受控日期范围起点（来自页面统一筛选器；空串 = 不限） */
    startDate?: string;
    /** 受控日期范围终点（来自页面统一筛选器；空串 = 不限） */
    endDate?: string;
    /**
     * 点击「编辑」回调 —— 由父级用统一录入弹窗承载。
     * 不传则不渲染编辑按钮（保持组件在只读场景下可复用）。
     */
    onEdit?: (row: CashBalanceResponse) => void;
    /** 空态「清除筛选」回调（存在日期条件时显示） */
    onClearFilter?: () => void;
  }>(),
  {
    startDate: '',
    endDate: '',
    onEdit: undefined,
    onClearFilter: undefined,
  },
);

const page = ref(1);
const deleting = ref<CashBalanceResponse | null>(null);
const deleteError = ref('');
/** 确认删除请求已发出（用于拒绝删除流程中的关闭请求，失败保持确认框打开） */
const confirmRequested = ref(false);

// 统一筛选器换范围后回到第 1 页，避免停留在越界页码看到空表
watch(
  () => [props.startDate, props.endDate],
  () => {
    page.value = 1;
  },
);

const preferenceStore = usePreferenceStore();
const amountThousands = computed(() =>
  preferenceStore.getPreference('amountThousands'),
);
const amountAbbrev = computed(() =>
  preferenceStore.getPreference('amountAbbrev'),
);

// 列表查询：空串不下发，避免 queryKey 里出现无意义的 '' 造成多余缓存分片
const listQuery = computed(() => ({
  page: page.value,
  pageSize: HISTORY_PAGE_SIZE,
  ...(props.startDate ? { startDate: props.startDate } : {}),
  ...(props.endDate ? { endDate: props.endDate } : {}),
}));

const { data, isLoading, isError } = useCashBalances(
  computed(() => props.portfolioId),
  listQuery,
);
const deleteMutation = useDeleteCashBalance();
const deletePending = computed(() => deleteMutation.isPending.value);

const items = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / HISTORY_PAGE_SIZE)),
);
const hasDateFilter = computed(() => Boolean(props.startDate || props.endDate));

function requestDelete(row: CashBalanceResponse): void {
  deleteError.value = '';
  deleting.value = row;
}

function handleConfirmDelete(): void {
  if (!deleting.value) return;
  deleteError.value = '';
  confirmRequested.value = true;
  deleteMutation.mutate(
    { portfolioId: props.portfolioId, id: deleting.value.id, asOf: deleting.value.asOf },
    {
      // 成功才关闭确认框；失败保留并就地说明原因（不吞错误）
      onSuccess: () => {
        deleting.value = null;
      },
      onError: (error) => {
        deleteError.value = resolveApiErrorMessage(
          error,
          '现金余额记录删除失败，请稍后重试',
        );
      },
      onSettled: () => {
        confirmRequested.value = false;
      },
    },
  );
}

/** 确认删除请求进行中拒绝关闭（保持弹窗与错误展示）；其余关闭路径正常清理 */
function handleDialogOpenChange(open: boolean): void {
  if (!open) {
    if (confirmRequested.value) return;
    deleting.value = null;
    deleteError.value = '';
  }
}

function prevPage(): void {
  page.value = Math.max(1, page.value - 1);
}

function nextPage(): void {
  page.value = Math.min(totalPages.value, page.value + 1);
}
</script>

<template>
  <div>
    <Skeleton v-if="isLoading" class="h-24 w-full" />

    <p v-else-if="isError" class="py-6 text-center text-xs text-muted-foreground">
      变更历史加载失败，请稍后重试
    </p>

    <div v-else-if="items.length === 0" class="space-y-2 py-6 text-center">
      <p class="text-xs text-muted-foreground">
        {{
          hasDateFilter
            ? '所选日期范围内暂无现金余额变更记录'
            : '暂无现金余额变更记录'
        }}
      </p>
      <Button
        v-if="hasDateFilter && props.onClearFilter"
        size="sm"
        variant="outline"
        @click="props.onClearFilter"
      >
        清除筛选
      </Button>
    </div>

    <div v-else class="space-y-3">
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-[120px]">生效日</TableHead>
              <TableHead class="text-right">金额</TableHead>
              <TableHead>备注</TableHead>
              <TableHead class="w-[110px]">更新时间</TableHead>
              <TableHead class="w-[90px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in items" :key="row.id">
              <TableCell class="whitespace-nowrap font-mono text-sm">
                {{ formatDate(row.asOf) }}
              </TableCell>
              <TableCell class="whitespace-nowrap text-right font-mono tabular-nums">
                {{ formatCurrency(row.amount, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
              </TableCell>
              <TableCell class="max-w-[180px]">
                <span class="truncate text-sm text-muted-foreground">
                  {{ row.note || '-' }}
                </span>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs text-muted-foreground">
                {{ formatDate(row.createdAt) }}
              </TableCell>
              <TableCell class="whitespace-nowrap text-right">
                <div class="flex justify-end gap-0.5">
                  <Button
                    v-if="props.onEdit"
                    size="icon"
                    variant="ghost"
                    class="h-7 w-7"
                    title="编辑（按生效日覆盖）"
                    :aria-label="`编辑 ${row.asOf} 的现金余额`"
                    @click="props.onEdit(row)"
                  >
                    <Pencil class="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    class="h-7 w-7 text-destructive"
                    title="删除"
                    :aria-label="`删除 ${row.asOf} 的现金余额`"
                    @click="requestDelete(row)"
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div
        v-if="total > HISTORY_PAGE_SIZE"
        class="flex items-center justify-between pt-2"
      >
        <span class="text-xs text-muted-foreground">
          共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页
        </span>
        <div class="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            :disabled="page <= 1"
            @click="prevPage"
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="page >= totalPages"
            @click="nextPage"
          >
            下一页
          </Button>
        </div>
      </div>
    </div>

    <!-- 删除二次确认（与出入金流水删除同一范式） -->
    <AlertDialog
      :open="Boolean(deleting)"
      @update:open="handleDialogOpenChange"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该条现金余额记录？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后，从该生效日起的净值与 XIRR 将被批量重算。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p
          v-if="deleteError"
          role="alert"
          class="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
        >
          <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{{ deleteError }}</span>
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deletePending">取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="deletePending"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="handleConfirmDelete"
          >
            <Loader2 v-if="deletePending" class="mr-2 h-4 w-4 animate-spin" />
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
