<script setup lang="ts">
/**
 * components/DividendList.vue — 分红记录列表 / 汇总（持仓页「分红」Tab，HOLD-B-P0-10，门面）
 *
 * 平移自 React 版 features/security-income/dividend-fee-section.tsx，行为契约一致：
 * - 区块标题「分红记录」+ 提示「独立记录，不参与 XIRR 与净值计算」+「录入分红」入口
 * - 汇总卡「累计分红（净额）」，按标的聚合累计分红（净额）= Σ(amount − tax)（K-2）
 * - [分红记录 ▾] 明细折叠表（日期 / 标的 / 类型 / 金额 / 所得税 / 净额 / 备注 / 操作）
 * - 录入 / 编辑共用同一表单弹窗；删除二次确认
 *
 * 口径：分红**不参与收益计算**，写入后仅失效 ['dividends'] 自身缓存（use-dividends 内处理）。
 *
 * I-05：标的多选 / 日期范围由页面统一筛选器派生，经 props 传入。
 *
 * 拆分说明（纯位置拆分，零行为变更）：
 * - components/DividendDetailCard   [分红记录 ▾] 明细折叠卡（open 经 v-model:open，edit/delete 上抛）
 * - components/DividendDeleteDialog 删除确认弹窗（confirm / update:open 上抛）
 * 数据 hook（useDividends / useDeleteDividend）与全部状态保留在本门面，子组件仅经 props
 * 接收、经 emit 回传，避免「子组件挂载依赖数据 → 请求永不触发」的死锁式重复请求。
 */

import { computed, ref } from 'vue';
import { Coins, Info, Plus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import EmptyState from '@/components/common/EmptyState.vue';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { usePreferenceStore } from '@/stores/preference.store';
import {
  useDeleteDividend,
  useDividends,
} from '../composables/use-dividends';
import { formatCurrency } from '@/lib/utils';
import type { DividendRecord } from '@/api/types';
import DividendForm from './DividendForm.vue';
import DividendDetailCard from './DividendDetailCard.vue';
import DividendDeleteDialog from './DividendDeleteDialog.vue';

/** 分红净额 = amount − tax（number，K-2） */
function netAmountOf(item: { amount: string; tax?: string | null }): number {
  return Number(item.amount) - Number(item.tax ?? 0);
}

/** 按标的聚合净额（K-2：股息 = Σ(amount − tax)，降序，同额按代码升序） */
interface SecurityIncomeRow {
  securityId: string;
  securityName: string;
  securityCode: string;
  dividendTotal: number;
}

function aggregateBySecurity(dividends: DividendRecord[]): SecurityIncomeRow[] {
  const map = new Map<string, SecurityIncomeRow>();
  const ensureRow = (
    securityId: string,
    securityName: string,
    securityCode: string,
  ): SecurityIncomeRow => {
    const existing = map.get(securityId);
    if (existing) return existing;
    const created: SecurityIncomeRow = {
      securityId,
      securityName,
      securityCode,
      dividendTotal: 0,
    };
    map.set(securityId, created);
    return created;
  };
  for (const item of dividends) {
    const row = ensureRow(item.securityId, item.securityName, item.securityCode);
    row.dividendTotal += netAmountOf(item);
  }
  return [...map.values()].sort(
    (a, b) =>
      b.dividendTotal - a.dividendTotal ||
      a.securityCode.localeCompare(b.securityCode),
  );
}

/** 分红净额求和（K-2：Σ(amount − tax)） */
function sumNetAmount(
  records: Array<{ amount: string; tax?: string | null }>,
): number {
  return records.reduce((acc, r) => acc + netAmountOf(r), 0);
}

const props = withDefaults(
  defineProps<{
    portfolioId: string;
    className?: string;
    /** I-05 统一筛选器派生：证券多选（空 = 全部） */
    securityIds?: string[];
    /** 起始日期 YYYY-MM-DD（含） */
    startDate?: string;
    /** 结束日期 YYYY-MM-DD（含） */
    endDate?: string;
  }>(),
  {
    className: '',
    securityIds: () => [],
    startDate: '',
    endDate: '',
  },
);

const securityIdParam = computed(() =>
  props.securityIds.length > 0 ? props.securityIds.join(',') : undefined,
);
// 分红（I-05：标的多值 / 日期范围）
const dividendsQuery = computed(() => ({
  securityId: securityIdParam.value,
  startDate: props.startDate || undefined,
  endDate: props.endDate || undefined,
}));
const {
  data: dividendsData,
  isLoading,
  isError,
  refetch,
} = useDividends(computed(() => props.portfolioId), dividendsQuery);
const deleteDividend = useDeleteDividend();

const preferenceStore = usePreferenceStore();
const amountThousands = computed(() =>
  preferenceStore.getPreference('amountThousands'),
);
const amountAbbrev = computed(() =>
  preferenceStore.getPreference('amountAbbrev'),
);
const moneyOpts = computed(() => ({
  thousands: amountThousands.value,
  abbreviate: amountAbbrev.value,
}));

// 录入 / 编辑弹窗（仅分红；编辑复用同一表单）
const formKind = ref<'dividend' | null>(null);
const editing = ref<DividendRecord | null>(null);
// 明细折叠状态（对应草图 [分红记录 ▾]）
const dividendOpen = ref(false);
// 删除确认
const deleting = ref<string | null>(null);

const dialogOpen = computed(() => formKind.value !== null || editing.value !== null);
function closeDialog(): void {
  formKind.value = null;
  editing.value = null;
}

const dividendList = computed(() => dividendsData.value ?? []);
const rows = computed(() => aggregateBySecurity(dividendList.value));
const dividendTotal = computed(() => sumNetAmount(dividendList.value));

function requestDelete(id: string): void {
  deleting.value = id;
}

function handleConfirmDelete(): void {
  if (!deleting.value) return;
  deleteDividend.mutate(
    { portfolioId: props.portfolioId, id: deleting.value },
    { onSuccess: () => { deleting.value = null; } },
  );
}

/**
 * 删除确认弹窗关闭处理。
 *
 * reka-ui AlertDialogAction（内部 DialogClose）的关闭 handler 与用户 @click 按
 * [reka, user] 顺序合并执行：reka 先 onOpenChange(false) 再跑用户 handler。
 * 同步清空 deleting 会让确认 handler 读不到删除目标（对齐 PortfolioManagementCard 模式）。
 */
function handleDeleteDialogOpenChange(open: boolean): void {
  if (!open) {
    queueMicrotask(() => (deleting.value = null));
  }
}

function handleRetry(): void {
  void refetch();
}
</script>

<template>
  <div :class="['space-y-4', props.className]" data-testid="dividend-fee-section">
    <!-- 区块标题 + 录入入口 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold">分红记录</h3>
        <p class="flex items-center gap-1 text-xs text-muted-foreground">
          <Info class="h-3 w-3" />
          独立记录，不参与 XIRR 与净值计算
        </p>
      </div>
      <Button
        :size="ENTRY_BUTTON_SIZE"
        :variant="ENTRY_BUTTON_VARIANT"
        @click="formKind = 'dividend'"
      >
        <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
        录入分红
      </Button>
    </div>

    <!-- 加载态 -->
    <div v-if="isLoading" class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <Skeleton class="h-[72px] w-full" />
        <Skeleton class="h-[72px] w-full" />
      </div>
      <Skeleton class="h-32 w-full" />
    </div>

    <!-- 错误态 -->
    <Card v-else-if="isError" class="border-destructive/50">
      <CardContent class="flex flex-col items-center gap-4 py-8">
        <Coins class="h-8 w-8 text-destructive" />
        <p class="text-sm text-destructive">分红数据加载失败</p>
        <Button variant="outline" size="sm" @click="handleRetry">重新加载</Button>
      </CardContent>
    </Card>

    <template v-else>
      <!-- 汇总卡：分红 = 收入 = 红（text-up）；分红按净额（K-2） -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardContent class="py-3">
            <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins class="h-3.5 w-3.5" />
              累计分红（净额）
            </p>
            <p class="text-lg font-bold tabular-nums text-up" data-testid="dividend-total">
              {{ formatCurrency(dividendTotal, 2, moneyOpts) }}
            </p>
          </CardContent>
        </Card>
      </div>

      <!-- 空态 -->
      <EmptyState v-if="rows.length === 0" title="暂无分红记录" description="分红为独立记录，不影响收益计算；可按标的追溯累计金额">
        <template #icon><Coins class="h-12 w-12" /></template>
        <template #action>
          <Button :variant="ENTRY_BUTTON_VARIANT" @click="formKind = 'dividend'">
            <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
            录入分红
          </Button>
        </template>
      </EmptyState>

      <!-- 按标的汇总（HOLD-B-P0-10 验收 2；分红列按净额 K-2） -->
      <Card v-if="rows.length > 0">
        <div class="overflow-x-auto">
          <Table data-testid="income-summary-table">
            <TableHeader>
              <TableRow>
                <TableHead class="sticky left-0 z-10 bg-background">标的</TableHead>
                <TableHead>代码</TableHead>
                <TableHead class="text-right">累计分红（净额）</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="row in rows" :key="row.securityId">
                <TableCell class="sticky left-0 z-10 bg-background font-medium">{{ row.securityName }}</TableCell>
                <TableCell class="text-muted-foreground">{{ row.securityCode }}</TableCell>
                <TableCell
                  class="text-right tabular-nums"
                  :class="row.dividendTotal > 0 ? 'text-up' : ''"
                >
                  {{ formatCurrency(row.dividendTotal, 2, moneyOpts) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Card>

      <!-- [分红记录 ▾] 明细（R-3：三列 金额/所得税/净额 + 编辑入口；I-02 tax/type 修复） -->
      <DividendDetailCard
        v-model:open="dividendOpen"
        :dividend-list="dividendList"
        :money-opts="moneyOpts"
        @edit="(item) => (editing = item)"
        @delete="requestDelete"
      />
    </template>

    <!-- 录入 / 编辑弹窗（仅分红） -->
    <Dialog :open="dialogOpen" @update:open="(v: boolean) => !v && closeDialog()">
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ editing ? '编辑分红' : '录入分红' }}</DialogTitle>
        </DialogHeader>
        <DividendForm
          v-if="dialogOpen"
          :key="editing ? `dividend-${editing.id}` : 'create'"
          :portfolio-id="props.portfolioId"
          :record="editing"
          :on-success="closeDialog"
        />
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <DividendDeleteDialog
      :open="Boolean(deleting)"
      @confirm="handleConfirmDelete"
      @update:open="handleDeleteDialogOpenChange"
    />
  </div>
</template>
