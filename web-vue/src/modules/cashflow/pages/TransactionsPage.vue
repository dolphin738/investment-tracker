<script setup lang="ts">
/**
 * modules/cashflow/pages/TransactionsPage.vue — 出入金管理页
 * （PRD §7.1 · 改版：统一筛选器 + Tab 分页）
 *
 * 平移自 React 版 pages/transactions.tsx，行为契约一致。
 *
 * 注：原【A】总资产展示卡片（当前总资产 / 持仓市值 / 近30日走势图 / 手工记录标记）
 * 已按 docs/designs/overview-fusion-2026-08-06.md 整体迁移至概览页（dashboard），
 * 本页不再展示总资产。
 *
 * 【改版要点】对齐持仓页 HoldingsPage 的「统一筛选器 + Tabs」范式：
 * 1. 筛选器合并：页面顶部单一筛选器，取代原先「出入金流水」「现金余额」各自
 *    独立的两套筛选。日期范围对两个页签同时生效；类型多选与排序仅作用于
 *    「出入金流水」（现金余额没有类型/排序维度 —— 后端 CashBalanceQuery 只有
 *    startDate/endDate/page/pageSize），控件上就近标注作用范围，避免误解。
 * 2. Tab 分页切换：【出入金流水】/【现金余额】两个页签，复用与持仓页同一套
 *    ui/tabs。Tabs 受控（本地状态）—— FLOW-P0-06 软提示需要程序化切到
 *    「现金余额」页签并打开录入弹窗（页签标识不写 URL，与持仓页同口径）。
 * 3. 现金余额页签版式参照「买卖明细」：上方当前余额（+ 提示），下方余额变更
 *    历史表格，每条支持编辑 / 删除（删除触发后端重算 + 前端缓存失效）。
 * 4. 录入弹窗：现金余额新增改为弹出对话框；编辑同一弹窗复用 CashBalanceForm。
 *
 * 筛选/排序/分页仍全部写入 URL query（FLOW-P0-02 验收2：刷新/分享保持）。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Info, Plus, RotateCcw } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyState from '@/components/common/EmptyState.vue';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import CashflowForm from '../components/CashflowForm.vue';
import CashflowList from '../components/CashflowList.vue';
import CashBalanceForm from '@/modules/cash-balance/components/CashBalanceForm.vue';
import CashBalanceHistory from '@/modules/cash-balance/components/CashBalanceHistory.vue';
import {
  parseTransactionSearchParams,
  SORT_OPTIONS,
  TRANSACTION_TYPE_OPTIONS,
  typesToParam,
  type TransactionTypeOption,
} from '../query-params';
import { CASH_BALANCE_FOCUS_EVENT } from '../composables/use-transactions';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/composables/use-portfolios';
import { useLatestCashBalance } from '@/modules/cash-balance/composables/use-cash-balances';
import { resolveQuickRange } from '@/modules/query/quick-range';
import { useDefaultDateRange } from '@/modules/query/use-default-date-range';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { CashBalanceResponse, TransactionQuery } from '@/api/types';

/** 页签标识（不写 URL，与持仓页 Tabs 同口径） */
type TransactionTab = 'cashflow' | 'balance';

const route = useRoute();
const router = useRouter();
const portfolioStore = usePortfolioStore();
const preferenceStore = usePreferenceStore();
// 「全部」快捷项的起点 = 组合首个交易日（问题②）
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);
// I-04：默认日期范围 = 偏好（URL 无 startDate/endDate 时），非法/空回落 '1y'
const defaultRange = useDefaultDateRange();
const portfoliosQuery = usePortfolios();
const portfolios = computed(() => portfoliosQuery.data.value ?? []);
const portfoliosLoading = computed(() => portfoliosQuery.isLoading.value);
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const amountThousands = computed(() =>
  preferenceStore.getPreference('amountThousands'),
);
const amountAbbrev = computed(() => preferenceStore.getPreference('amountAbbrev'));

/** 当前页签（受控：软提示需要程序化切到「现金余额」） */
const tab = ref<TransactionTab>('cashflow');
/** 出入金录入弹窗 */
const open = ref(false);
/** 现金余额录入/编辑弹窗（editingBalance 为 null 即新增） */
const balanceDialogOpen = ref(false);
const editingBalance = ref<CashBalanceResponse | null>(null);

// ── 统一筛选/排序/分页 ← URL query（FLOW-P0-02 验收2：刷新/分享保持） ──

/** vue-router 的 LocationQuery → URLSearchParams（复用 React 版纯函数解码器） */
function locationQueryToSearchParams(): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(route.query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) sp.set(key, String(first));
  }
  return sp;
}

const parsed = computed(() => parseTransactionSearchParams(locationQueryToSearchParams()));

/**
 * INC-01：快捷范围受控回显（URL range 为唯一真相源）。
 *
 * 本页范围状态完全存放在 URL 上，可同步派生：
 *   - URL 有 range → 用它（用户已显式指定，偏好后续变化不再弹回）；
 *   - URL 只有 startDate/endDate（手动改过日期）→ 回显占位「自定义」；
 *   - URL 全空 → 回落偏好 defaultRange，偏好一到达即自动生效。
 * 派生写法天然满足「不覆盖用户选择 / 偏好可迟到」两条约束，且不会在
 * 挂载时反写 URL（污染分享链接 + 「重置」后回显错位）。
 */
const urlRange = computed(() => {
  const raw = route.query.range;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ?? '';
});
const hasExplicitDates = computed(() =>
  Boolean(parsed.value.startDate || parsed.value.endDate),
);
const quickValue = computed(() =>
  urlRange.value || (hasExplicitDates.value ? '' : defaultRange.value),
);
const fallbackRangeValue = computed(() =>
  resolveQuickRange(quickValue.value || defaultRange.value, {
    allRangeStart: baseDate.value ?? undefined,
  }),
);

// URL 参数优先；无 startDate/endDate 时按 quickValue（偏好或 URL range）解析
const filterStartDate = computed(
  () => parsed.value.startDate || fallbackRangeValue.value.startDate,
);
const filterEndDate = computed(
  () => parsed.value.endDate || fallbackRangeValue.value.endDate,
);

/** 更新 URL query（null / '' 删除该参数；变更即生效，无需「筛选」按钮） */
function updateParams(patch: Record<string, string | number | null>) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(route.query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) next[key] = String(first);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') {
      delete next[key];
    } else {
      next[key] = String(value);
    }
  }
  router.push({ query: next });
}

/** 类型多选切换（全不勾 = 全部，Part E-1） */
function handleToggleType(t: TransactionTypeOption) {
  const current = parsed.value.types;
  const next = current.includes(t)
    ? current.filter((x) => x !== t)
    : [...current, t];
  updateParams({ types: typesToParam(next), page: 1 });
}

/** 重置：清空全部筛选/排序/分页参数（回落到 全部 + date desc + 第 1 页 + 20 条） */
function handleResetFilter() {
  router.push({ query: {} });
}

/** 排序切换（value = `${sortBy}:${sortOrder}`，如 date:desc） */
function handleSortChange(v: string) {
  const [by, order] = v.split(':');
  updateParams({ sortBy: by, sortOrder: order, page: 1 });
}

function handlePageChange(p: number) {
  updateParams({ page: p });
}

function handlePageSizeChange(size: number) {
  updateParams({ pageSize: size, page: 1 });
}

/** 统一筛选器日期范围变更：选中快捷项写 range；手动改日期清 range（回显占位） */
function handleRangeChange(r: { startDate: string; endDate: string; quick?: string }) {
  updateParams({
    range: r.quick || null,
    startDate: r.startDate || null,
    endDate: r.endDate || null,
    page: 1,
  });
}

/**
 * 传给出入金流水列表的查询参数：日期范围 + 非默认排序。
 * F5 仅非默认时透传（默认 date desc 与后端现状一致，避免后端 F5 未落盘时白名单 400）。
 */
const listQuery = computed<TransactionQuery>(() => {
  const q: TransactionQuery = {};
  if (filterStartDate.value) q.startDate = filterStartDate.value;
  if (filterEndDate.value) q.endDate = filterEndDate.value;
  if (parsed.value.sortBy === 'amount' || parsed.value.sortOrder === 'asc') {
    q.sortBy = parsed.value.sortBy;
    q.sortOrder = parsed.value.sortOrder;
  }
  return q;
});

const latestBalance = useLatestCashBalance(currentPortfolioId);
const cashBalance = computed(() => latestBalance.data.value?.amount);

/** 打开现金余额新增弹窗 */
function openCreateBalance() {
  editingBalance.value = null;
  balanceDialogOpen.value = true;
}

/** 打开现金余额编辑弹窗（复用同一表单组件） */
function openEditBalance(row: CashBalanceResponse) {
  editingBalance.value = row;
  balanceDialogOpen.value = true;
}

// FLOW-P0-06：监听软提示「去更新」事件 → 切到「现金余额」页签并打开录入弹窗
// （只引导，绝不自动修改 CashBalance；事件由 use-transactions 的 soft hint action 派发）
function handleCashBalanceFocus() {
  tab.value = 'balance';
  openCreateBalance();
}

onMounted(() => {
  window.addEventListener(CASH_BALANCE_FOCUS_EVENT, handleCashBalanceFocus);
});

onBeforeUnmount(() => {
  window.removeEventListener(CASH_BALANCE_FOCUS_EVENT, handleCashBalanceFocus);
});
</script>

<template>
  <!-- ===== 加载态 ===== -->
  <div v-if="portfoliosLoading" class="space-y-6">
    <Skeleton class="h-8 w-40" />
    <Skeleton class="h-40 w-full" />
  </div>

  <!-- ===== 无组合 ===== -->
  <Card v-else-if="portfolios.length === 0" class="mx-auto max-w-md">
    <CardContent class="py-10">
      <EmptyState
        title="暂无投资组合"
        description="请先在账户页「我的组合」创建组合"
      />
    </CardContent>
  </Card>

  <Card v-else-if="!currentPortfolioId" class="mx-auto max-w-md">
    <CardContent class="py-10">
      <EmptyState title="请先在顶部选择一个投资组合" />
    </CardContent>
  </Card>

  <div v-else class="space-y-6">
    <!-- 页头 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">出入金管理</h1>
        <p class="text-sm text-muted-foreground">
          管理存入/取出现金流与现金余额，系统据此计算净值与 XIRR
        </p>
      </div>
      <!-- INC-05：与概览页「录入买卖」同规格（主色 + sm + Plus），文案取统一字典；
          录入现金余额置于录入出入金左侧，两者水平并排、规格一致便于操作 -->
      <div class="flex items-center gap-2">
        <Button
          :variant="ENTRY_BUTTON_VARIANT"
          :size="ENTRY_BUTTON_SIZE"
          @click="openCreateBalance"
        >
          <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
          {{ ENTRY_BUTTON_LABELS.cashBalance }}
        </Button>
        <Button
          :variant="ENTRY_BUTTON_VARIANT"
          :size="ENTRY_BUTTON_SIZE"
          @click="open = true"
        >
          <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
          {{ ENTRY_BUTTON_LABELS.cashFlow }}
        </Button>
      </div>
    </div>

    <!-- ============ 统一筛选器（两个页签共享，变更即写入 URL query） ============ -->
    <Card>
      <CardHeader class="pb-3">
        <CardTitle class="text-base">筛选</CardTitle>
        <CardDescription>
          日期范围对「出入金流水」与「现金余额」同时生效；类型与排序仅作用于出入金流水
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex flex-wrap items-end gap-3">
          <!--
            问题⑥：把「不勾选 = 全部」并入 Label，使「类型」这一列与其它列
            都是「Label + h-9 控件」的等高结构，items-end 下天然对齐。
          -->
          <div class="space-y-1.5">
            <Label class="text-xs">类型（不勾选 = 全部 · 仅流水）</Label>
            <div class="flex h-9 items-center gap-4 rounded-md border border-input px-3">
              <label
                v-for="t in TRANSACTION_TYPE_OPTIONS"
                :key="t"
                class="flex cursor-pointer items-center gap-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 accent-primary"
                  :checked="parsed.types.includes(t)"
                  @change="handleToggleType(t)"
                />
                <span :class="t === 'BUY' ? 'text-up' : 'text-down'">
                  {{ t === 'BUY' ? '存入' : '取出' }}
                </span>
              </label>
            </div>
          </div>
          <!-- 问题⑤⑥：接入共享快捷范围控件，与资产记录页同一实现 -->
          <DateRangeQuickPicker
            :quick="quickValue"
            :start-date="filterStartDate"
            :end-date="filterEndDate"
            :all-range-start="baseDate"
            @change="handleRangeChange"
          />
          <div class="space-y-1.5">
            <Label class="text-xs">排序（仅流水）</Label>
            <Select
              :model-value="`${parsed.sortBy}:${parsed.sortOrder}`"
              @update:model-value="handleSortChange"
            >
              <SelectTrigger class="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="opt in SORT_OPTIONS"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex gap-2">
            <Button size="sm" variant="outline" @click="handleResetFilter">
              <RotateCcw class="mr-1 h-3.5 w-3.5" />
              重置
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- ============ 页签：出入金流水 / 现金余额 ============ -->
    <Tabs v-model="tab">
      <TabsList>
        <TabsTrigger value="cashflow">出入金流水</TabsTrigger>
        <TabsTrigger value="balance">现金余额</TabsTrigger>
      </TabsList>

      <!-- ---------- 出入金流水 ---------- -->
      <TabsContent value="cashflow" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">出入金流水</CardTitle>
            <CardDescription>
              按顶部统一筛选器的日期范围 / 类型 / 排序展示；编辑/删除将触发重算
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CashflowList
              :portfolio-id="currentPortfolioId"
              :query="listQuery"
              :types="parsed.types"
              :page="parsed.page"
              :page-size="parsed.pageSize"
              :on-page-change="handlePageChange"
              :on-page-size-change="handlePageSizeChange"
              :on-clear-filter="handleResetFilter"
            />
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ---------- 现金余额（版式参照「买卖明细」：上当前值 + 下变更历史） ---------- -->
      <TabsContent value="balance" class="mt-4">
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
                  v-if="cashBalance !== undefined && cashBalance !== null && latestBalance.data.value"
                  class="mt-0.5 text-xs text-muted-foreground"
                >
                  自 {{ formatDate(latestBalance.data.value.asOf) }} 起沿用
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
                :on-edit="openEditBalance"
                :on-clear-filter="handleResetFilter"
              />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- 录入/编辑出入金弹窗 -->
    <Dialog
      :open="open"
      @update:open="(o) => { open = o; }"
    >
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ ENTRY_BUTTON_LABELS.cashFlow }}</DialogTitle>
        </DialogHeader>
        <CashflowForm
          :portfolio-id="currentPortfolioId"
          :on-success="() => { open = false; }"
        />
      </DialogContent>
    </Dialog>

    <!-- 录入/编辑现金余额弹窗（新增与编辑复用同一表单组件） -->
    <Dialog
      :open="balanceDialogOpen"
      @update:open="(o) => {
        balanceDialogOpen = o;
        if (!o) editingBalance = null;
      }"
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
          :on-success="() => {
            balanceDialogOpen = false;
            editingBalance = null;
          }"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>
