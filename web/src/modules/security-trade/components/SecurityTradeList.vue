<script setup lang="ts">
/**
 * modules/security-trade/components/SecurityTradeList.vue — 证券买卖明细流水表格
 *
 * 平移自 React 版 web/src/features/security-trade/security-trade-list.tsx。
 *
 * PRD §7.2【C】：列表 + 筛选（标的/日期/方向）+ 编辑/删除。
 * 交易响应不含标的名称，由 securities 列表字典映射展示。
 *
 * 行为契约对齐要点：
 * - 筛选三态短路（缺陷4 二次修复）：`filterState !== 'ready'` 时禁用列表查询，
 *   绝不退化成「无 securityId → 后端返回全量」导致筛选器失效；
 *   loading 显示骨架、empty 显示空态，均不发请求。
 * - 三统计块口径（INC-03）：买入金额 = Σ(BUY qty×costPrice)、卖出金额 = Σ(SELL)、
 *   累计费用 = Σ(feeTotal)，随当前可见结果集动态变化。
 * - mutation（删除）成功后由 useDeleteSecurityTrade 失效 ['security-trades'] 前缀缓存，
 *   本列表 queryKey 同前缀，自动刷新。
 */

import { computed, ref } from 'vue';
import { ChevronLeft, ChevronRight, Pencil, Trash2, Loader2 } from 'lucide-vue-next';
import { useQuery } from '@tanstack/vue-query';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { listSecurityTrades } from '@/api/security-trade.api';
import { useSecurities } from '@/composables/use-securities';
import { useDeleteSecurityTrade } from '../composables/use-security-trades';
import SecurityTradeForm from './SecurityTradeForm.vue';
import type { SecurityTradeQuery, SecurityTradeResponse } from '@/api/types';
import type { TradeFilterState } from '@/modules/holdings/trade-security-filter';
import { SecuritySide } from '@/lib/types';
import { formatCurrency, formatDate } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    portfolioId: string;
    /** 查询参数（标的/日期范围；分页在组件内维护） */
    query?: SecurityTradeQuery;
    /** 方向筛选（'all' | 'BUY_SEC' | 'SELL_SEC'；后端按 side 参数过滤） */
    sideFilter?: 'all' | 'BUY_SEC' | 'SELL_SEC';
    /** 外部筛选就绪状态（默认 'ready'），见 TradeFilterState */
    filterState?: TradeFilterState;
    emptyText?: string;
    /** filterState==='empty' 时的空态文案（默认与 emptyText 一致） */
    filteredEmptyText?: string;
    class?: string;
  }>(),
  {
    sideFilter: 'all',
    filterState: 'ready',
    emptyText: '暂无买卖流水',
  },
);

const PAGE_SIZE = 20;

const page = ref(1);
const editing = ref<SecurityTradeResponse | null>(null);
const deletingId = ref<string | null>(null);

// filterState !== 'ready' 时禁用查询（短路），避免「筛选无匹配 / 字典未就绪」
// 被后端理解为「无筛选条件」而返回全量数据。
const queryEnabled = computed(() => props.filterState === 'ready');

const listQuery = computed<SecurityTradeQuery>(() => ({
  ...(props.query ?? {}),
  ...(props.sideFilter !== 'all' ? { side: props.sideFilter as SecuritySide } : {}),
  page: page.value,
  pageSize: PAGE_SIZE,
}));

const {
  data,
  isLoading: tradesLoading,
  isError,
} = useQuery({
  queryKey: computed(() => [
    'security-trades',
    'list',
    queryEnabled.value ? props.portfolioId : 'disabled',
    listQuery.value,
  ]),
  queryFn: () => listSecurityTrades(props.portfolioId, listQuery.value),
  enabled: queryEnabled,
  staleTime: 30 * 1000,
});

const { data: securitiesData } = useSecurities(props.portfolioId);
const securityMap = computed(
  () => new Map((securitiesData.value ?? []).map((s) => [s.id, s])),
);

const items = computed<SecurityTradeResponse[]>(() =>
  queryEnabled.value ? (data.value?.items ?? []) : [],
);
const total = computed(() => (queryEnabled.value ? (data.value?.total ?? 0) : 0));
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

const isLoading = computed(
  () => props.filterState === 'loading' || tradesLoading.value,
);
const resolvedEmptyText = computed(() =>
  props.filterState === 'empty'
    ? (props.filteredEmptyText ?? props.emptyText)
    : props.emptyText,
);

/** 当前页统计：买入金额（含费成交额）/ 卖出金额（含费成交额）/ 累计费用合计 */
const buyAmount = computed(() =>
  items.value
    .filter((t) => t.side === SecuritySide.BUY_SEC)
    .reduce((sum, t) => sum + Number(t.quantity) * Number(t.costPrice), 0),
);
const sellAmount = computed(() =>
  items.value
    .filter((t) => t.side === SecuritySide.SELL_SEC)
    .reduce((sum, t) => sum + Number(t.quantity) * Number(t.costPrice), 0),
);
const totalFee = computed(() =>
  items.value.reduce((sum, t) => sum + Number(t.feeTotal), 0),
);

const deleteMutation = useDeleteSecurityTrade();
const isDeleting = computed(() => deleteMutation.isPending.value);
/**
 * 删除确认弹窗关闭处理。
 *
 * reka-ui AlertDialogAction（内部 DialogClose）的关闭 handler 与用户 @click 按
 * [reka, user] 顺序合并执行：reka 先 onOpenChange(false) 再跑用户 handler。
 * 故「清空 deletingId」必须延迟到微任务，否则用户确认 handler 执行时 id 已被清空，
 * 删除 mutation 拿不到参数（对齐 PortfolioManagementCard 的删除模式）。
 */
function handleDeleteDialogOpenChange(o: boolean): void {
  if (!o) {
    queueMicrotask(() => (deletingId.value = null));
  }
}

function handleConfirmDelete(): void {
  if (!deletingId.value) return;
  deleteMutation.mutate(
    { portfolioId: props.portfolioId, id: deletingId.value },
    { onSettled: () => (deletingId.value = null) },
  );
}

/** 成交额（含费）= 数量 × 含费单价 */
function amountOf(t: SecurityTradeResponse): number {
  return Number(t.quantity) * Number(t.costPrice);
}
</script>

<template>
  <div :class="props.class">
    <!-- 加载态骨架 -->
    <div v-if="isLoading" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" class="h-12 w-full" />
    </div>

    <!-- 错误态 -->
    <div
      v-else-if="isError"
      class="py-10 text-center text-sm text-muted-foreground"
    >
      加载失败，请稍后重试
    </div>

    <!-- 空态 -->
    <div
      v-else-if="items.length === 0"
      class="py-10 text-center text-sm text-muted-foreground"
    >
      {{ resolvedEmptyText }}
    </div>

    <!-- 数据态 -->
    <template v-else>
      <!-- 三统计块 -->
      <div class="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-md border bg-muted/40 px-4 py-3">
          <p class="text-xs text-muted-foreground">买入金额（含费）</p>
          <p class="mt-1 font-mono text-base font-medium tabular-nums text-up">
            {{ formatCurrency(buyAmount, 2) }}
          </p>
        </div>
        <div class="rounded-md border bg-muted/40 px-4 py-3">
          <p class="text-xs text-muted-foreground">卖出金额（含费）</p>
          <p class="mt-1 font-mono text-base font-medium tabular-nums text-down">
            {{ formatCurrency(sellAmount, 2) }}
          </p>
        </div>
        <div class="rounded-md border bg-muted/40 px-4 py-3">
          <p class="text-xs text-muted-foreground">累计费用合计</p>
          <p class="mt-1 font-mono text-base font-medium tabular-nums">
            {{ formatCurrency(totalFee, 2) }}
          </p>
        </div>
      </div>

      <!-- 流水表 -->
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-[100px]">日期</TableHead>
              <TableHead class="w-[60px]">方向</TableHead>
              <TableHead>标的</TableHead>
              <TableHead class="text-right">数量</TableHead>
              <TableHead class="text-right">成本价</TableHead>
              <TableHead class="text-right">佣金</TableHead>
              <TableHead class="text-right">印花税</TableHead>
              <TableHead class="text-right">其他</TableHead>
              <TableHead class="text-right">费用合计</TableHead>
              <TableHead class="text-right">成交额</TableHead>
              <TableHead class="w-[100px]">备注</TableHead>
              <TableHead class="w-[80px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="t in items" :key="t.id">
              <TableCell class="font-mono text-sm whitespace-nowrap">
                {{ formatDate(t.date) }}
              </TableCell>
              <TableCell>
                <Badge
                  v-if="t.side === SecuritySide.BUY_SEC"
                  variant="secondary"
                  class="bg-up-soft text-up"
                >
                  买入
                </Badge>
                <Badge v-else variant="outline" class="bg-down-soft text-down">
                  卖出
                </Badge>
              </TableCell>
              <TableCell class="text-sm whitespace-nowrap">
                <span v-if="securityMap.get(t.securityId)">
                  {{ securityMap.get(t.securityId)!.name }}
                  <span class="ml-1 text-xs text-muted-foreground">
                    {{ securityMap.get(t.securityId)!.code }}
                  </span>
                </span>
                <span v-else>-</span>
              </TableCell>
              <TableCell class="text-right font-mono text-sm whitespace-nowrap">
                {{ Number(t.quantity).toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }}
              </TableCell>
              <TableCell class="text-right font-mono text-sm whitespace-nowrap">
                {{ formatCurrency(t.costPrice, 6) }}
              </TableCell>
              <TableCell class="text-right font-mono text-sm whitespace-nowrap">
                {{ formatCurrency(t.commission, 2) }}
              </TableCell>
              <TableCell class="text-right font-mono text-sm whitespace-nowrap">
                {{ formatCurrency(t.stampTax, 2) }}
              </TableCell>
              <TableCell class="text-right font-mono text-sm whitespace-nowrap">
                {{ formatCurrency(t.other, 2) }}
              </TableCell>
              <TableCell class="text-right font-mono text-sm whitespace-nowrap">
                {{ formatCurrency(t.feeTotal, 2) }}
              </TableCell>
              <TableCell class="text-right font-mono whitespace-nowrap">
                {{ formatCurrency(amountOf(t), 2) }}
              </TableCell>
              <TableCell class="max-w-[110px] truncate text-sm text-muted-foreground">
                {{ t.note || '-' }}
              </TableCell>
              <TableCell class="text-right whitespace-nowrap">
                <div class="flex justify-end gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="编辑"
                    @click="editing = t"
                  >
                    <Pencil class="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="删除"
                    @click="deletingId = t.id"
                  >
                    <Trash2 class="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <!-- 分页 -->
      <div
        v-if="total > PAGE_SIZE"
        class="flex items-center justify-between pt-3"
      >
        <span class="text-xs text-muted-foreground">
          共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页
        </span>
        <div class="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            :disabled="page <= 1"
            @click="page = Math.max(1, page - 1)"
          >
            <ChevronLeft class="h-4 w-4" />
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="page >= totalPages"
            @click="page = Math.min(totalPages, page + 1)"
          >
            下一页
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </template>

    <!-- 编辑弹窗 -->
    <Dialog :open="Boolean(editing)" @update:open="(o) => !o && (editing = null)">
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑买卖流水</DialogTitle>
        </DialogHeader>
        <SecurityTradeForm
          :portfolio-id="props.portfolioId"
          :trade="editing"
          @success="editing = null"
        />
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <AlertDialog
      :open="Boolean(deletingId)"
      @update:open="handleDeleteDialogOpenChange"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该笔买卖流水？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后持仓将重新推导，并从该日期起的净值与 XIRR 将被重算。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="isDeleting">取消</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            :disabled="isDeleting"
            @click="handleConfirmDelete"
          >
            <Loader2 v-if="isDeleting" class="mr-2 h-4 w-4 animate-spin" />
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
