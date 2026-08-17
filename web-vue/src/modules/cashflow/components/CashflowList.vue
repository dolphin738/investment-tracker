<script setup lang="ts">
/**
 * modules/cashflow/components/CashflowList.vue — 出入金流水表格
 *
 * 平移自 React 版 features/cashflow/cashflow-list.tsx，行为契约一致。
 *
 * PRD §7.1【C】：表格（日期/类型/金额/备注/操作）+ 分页（20/50/100）。
 * 类型筛选由后端按 types 参数过滤（F2 已获批，Part E-1 多选语义），
 * 前端只透传筛选条件，不再对当前页数据做过滤。
 * 分页为受控组件：page/pageSize 由父页面持有（URL query，FLOW-P0-02 验收2）。
 */

import { computed, ref } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  RotateCcw,
  Trash2,
  Loader2,
} from 'lucide-vue-next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  useTransactions,
  useDeleteTransaction,
} from '../composables/use-transactions';
import CashflowForm from './CashflowForm.vue';
import { PAGE_SIZE_OPTIONS } from '../query-params';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import type { TransactionQuery, TransactionResponse } from '@/api/types';
import { CashFlowType } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    portfolioId: string;
    /** 查询参数（日期范围/排序等，不含 page/pageSize/types） */
    query?: TransactionQuery;
    /** 类型多选（空数组 = 全部；F2 已获批透传 types，Part E-1 语义） */
    types?: Array<'BUY' | 'SELL'>;
    /** 当前页码（受控，URL query 持有） */
    page: number;
    /** 每页条数（受控，20/50/100，URL query 持有） */
    pageSize: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
    /** 空态「清除筛选」回调（存在非默认筛选条件时显示） */
    onClearFilter?: () => void;
    /** 空状态时的提示文案 */
    emptyText?: string;
  }>(),
  {
    query: undefined,
    types: () => [],
    onClearFilter: undefined,
    emptyText: '暂无出入金流水',
  },
);

const editing = ref<TransactionResponse | null>(null);
const deletingId = ref<string | null>(null);

// 列表查询：日期范围/排序 + 类型多选 + 受控分页（queryKey 随 props 响应）
const listQuery = computed<TransactionQuery>(() => ({
  ...props.query,
  ...(props.types.length > 0 ? { types: props.types } : {}),
  page: props.page,
  pageSize: props.pageSize,
}));

const { data, isLoading, isError } = useTransactions(
  computed(() => props.portfolioId),
  listQuery,
);
const deleteMutation = useDeleteTransaction();
const deletePending = computed(() => deleteMutation.isPending.value);

const items = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / props.pageSize)),
);

/** 是否存在非默认筛选条件（决定空态是否展示「清除筛选」按钮） */
const hasActiveFilters = computed(
  () =>
    props.types.length > 0 ||
    Boolean(props.query?.startDate) ||
    Boolean(props.query?.endDate) ||
    props.query?.sortBy === 'amount' ||
    props.query?.sortOrder === 'asc' ||
    props.page > 1,
);

function handleConfirmDelete(): void {
  if (deletingId.value) {
    deleteMutation.mutate(
      { portfolioId: props.portfolioId, id: deletingId.value },
      { onSettled: () => { deletingId.value = null; } },
    );
  }
}

function handlePageSizeChange(v: string): void {
  props.onPageSizeChange(Number(v));
}
</script>

<template>
  <div>
    <div v-if="isLoading" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" class="h-12 w-full" />
    </div>

    <div v-else-if="isError" class="py-10 text-center text-sm text-muted-foreground">
      加载失败，请稍后重试
    </div>

    <!-- FLOW-P0-02 验收5：空态 + 「清除筛选」按钮（有非默认筛选条件时） -->
    <div v-else-if="items.length === 0" class="py-10 text-center">
      <p class="text-sm text-muted-foreground">{{ props.emptyText }}</p>
      <Button
        v-if="hasActiveFilters && props.onClearFilter"
        size="sm"
        variant="outline"
        class="mt-3"
        @click="props.onClearFilter"
      >
        <RotateCcw class="mr-1 h-3.5 w-3.5" />
        清除筛选
      </Button>
    </div>

    <div v-else class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-[110px]">日期</TableHead>
            <TableHead class="w-[70px]">类型</TableHead>
            <TableHead class="text-right">金额</TableHead>
            <TableHead>备注</TableHead>
            <TableHead class="w-[80px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="tx in items" :key="tx.id">
            <TableCell class="font-mono text-sm whitespace-nowrap">
              {{ formatDate(tx.date) }}
            </TableCell>
            <TableCell>
              <Badge
                :variant="tx.type === CashFlowType.BUY ? 'secondary' : 'outline'"
                :class="cn(
                  tx.type === CashFlowType.BUY
                    ? 'bg-up-soft text-up'
                    : 'bg-down-soft text-down',
                )"
              >
                {{ tx.type === CashFlowType.BUY ? '存入' : '取出' }}
              </Badge>
            </TableCell>
            <TableCell
              :class="cn(
                'text-right font-mono tabular-nums whitespace-nowrap',
                tx.type === CashFlowType.BUY ? 'text-up' : 'text-down',
              )"
            >
              {{ tx.type === CashFlowType.BUY ? '+' : '-' }}{{ formatCurrency(tx.amount) }}
            </TableCell>
            <TableCell class="max-w-[180px] truncate text-sm text-muted-foreground">
              {{ tx.note || '-' }}
            </TableCell>
            <TableCell class="text-right whitespace-nowrap">
              <div class="flex justify-end gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  title="编辑"
                  @click="editing = tx"
                >
                  <Pencil class="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="删除"
                  @click="deletingId = tx.id"
                >
                  <Trash2 class="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <!-- 分页：页码 + 每页条数（20/50/100）+ 上/下一页 -->
    <div
      v-if="!isLoading && !isError && total > 0"
      class="flex flex-wrap items-center justify-between gap-3 pt-3"
    >
      <div class="flex items-center gap-2">
        <span class="text-xs text-muted-foreground">
          共 {{ total }} 条 · 第 {{ props.page }}/{{ totalPages }} 页
        </span>
        <Select
          :model-value="String(props.pageSize)"
          @update:model-value="handlePageSizeChange"
        >
          <SelectTrigger class="h-8 w-[92px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="opt in PAGE_SIZE_OPTIONS"
              :key="opt"
              :value="String(opt)"
            >
              {{ opt }} / 页
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          :disabled="props.page <= 1"
          @click="props.onPageChange(props.page - 1)"
        >
          <ChevronLeft class="h-4 w-4" />
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="props.page >= totalPages"
          @click="props.onPageChange(props.page + 1)"
        >
          下一页
          <ChevronRight class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <Dialog
      :open="Boolean(editing)"
      @update:open="(o) => { if (!o) editing = null; }"
    >
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑出入金</DialogTitle>
        </DialogHeader>
        <CashflowForm
          v-if="editing"
          :portfolio-id="props.portfolioId"
          :cashflow="editing"
          :on-success="() => { editing = null; }"
        />
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <AlertDialog
      :open="Boolean(deletingId)"
      @update:open="(o) => { if (!o) deletingId = null; }"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该笔出入金？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后，从该日期起的净值与 XIRR 将被批量重算。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deletePending">取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="deletePending"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="handleConfirmDelete"
          >
            <Loader2 v-if="deletePending" class="mr-2 h-4 w-4 animate-spin" />
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
