<script setup lang="ts">
/**
 * modules/snapshot/components/SnapshotList.vue — 资产快照记录表格（PRD §7.3）
 *
 * 平移自 React 版 web/src/features/snapshot/snapshot-list.tsx，行为契约一致：
 * - 列：日期/总资产/持仓/现金/来源（自动/手工）/系统自动值+差异/备注/操作
 * - 操作：编辑（手工行 PATCH；自动行由页面以「变手工」方式打开）、
 *   删除（事件日会重新生成自动值）、重置（仅手工记录，恢复系统值）
 * - 筛选行：日期范围 + 来源 checkbox（自动/手工）+ [重置]
 * - 顶部差异提示条：「当前有 N 条手工记录，其中 M 条与自动值差异 > 1%」+ [仅看手工]
 * - 手工行差异列：系统自动计算值 + 差异金额 +（差异%）
 */

import { computed, ref, watch, type Ref } from 'vue';
import {
  AlertTriangle,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
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
import { Label } from '@/components/ui/label';
import Pagination from '@/components/common/Pagination.vue';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
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
import { resolveQuickRange } from '@/modules/query/quick-range';
import { useRangePreferenceSync } from '@/modules/analysis/composables/use-range-preference-sync';
import {
  useDeleteSnapshot,
  useResetSnapshot,
  useSnapshots,
} from '../composables/use-snapshots';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import {
  computeManualDiffStats,
  formatAmountChange,
  formatCurrency,
  formatDate,
} from '@/lib/utils';
import type { SnapshotQuery, SnapshotResponse } from '@/api/types';
import { SnapshotSource, type AssetSnapshot } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    portfolioId: string;
    query?: SnapshotQuery;
    class?: string;
    emptyText?: string;
  }>(),
  { emptyText: '暂无资产记录' },
);

const emit = defineEmits<{
  /** 点击编辑（页面打开 SnapshotForm 弹窗） */
  edit: [item: AssetSnapshot];
}>();

const PAGE_SIZE = 20;

const page = ref(1);
const deleting = ref<SnapshotResponse | null>(null);
const resetting = ref<SnapshotResponse | null>(null);

// 筛选行本地状态（日期起止 + 来源 checkbox；「重置」清空）
const filterStart = ref('');
const filterEnd = ref('');
// INC-01：快捷范围受控回显（空串 = 不限 / 自定义）
const filterQuick = ref('');
// 「全部」快捷项的起点 = 组合首个交易日（问题②）
const portfolioStore = usePortfolioStore();
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);
const autoChecked = ref(true);
const manualChecked = ref(true);

/**
 * 偏好默认范围对齐守卫（INC-01 决策 E · 统一范式）。
 *
 * 本组件原先不读偏好（起止恒为空串 = 不限），INC-01 要求 5 个统一页面一致：
 * 首帧后按 defaultDateRange 对齐一次；用户一旦手动改过范围即不再对齐。
 * 组件无 URL 载体，urlParamKeys 传空数组跳过 URL 判定。
 */
const { defaultRange, markInteracted } = useRangePreferenceSync({
  currentQuick: () => filterQuick.value,
  currentStartDate: () => filterStart.value,
  allRangeStart: baseDate,
  urlParamKeys: [],
  onAlign: (alignment) => {
    filterQuick.value = alignment.quick;
    filterStart.value = alignment.startDate;
    filterEnd.value = alignment.endDate;
  },
});

// 偏好（金额格式）
const preferenceStore = usePreferenceStore();
const amountThousands = preferenceStore.getPreference('amountThousands');
const amountAbbrev = preferenceStore.getPreference('amountAbbrev');
const fmtOpts = { thousands: amountThousands, abbreviate: amountAbbrev };

// 筛选条件变化时回到第一页
watch(
  [filterStart, filterEnd, autoChecked, manualChecked],
  () => {
    page.value = 1;
  },
);

// 来源筛选：两勾选相同（全选/全不选）= 不筛；仅自动 = DERIVED；仅手工 = MANUAL
// F2 已获批：source 走服务端筛选（后端 DTO 落盘前联调注意先后顺序）
const sourceQuery = computed<SnapshotSource | undefined>(() =>
  autoChecked.value === manualChecked.value
    ? props.query?.source
    : autoChecked.value
      ? SnapshotSource.DERIVED
      : SnapshotSource.MANUAL,
);

const listQuery = computed<SnapshotQuery>(() => ({
  ...props.query,
  startDate: filterStart.value || props.query?.startDate,
  endDate: filterEnd.value || props.query?.endDate,
  source: sourceQuery.value,
  page: page.value,
  pageSize: PAGE_SIZE,
}));

const { data, isLoading, isError } = useSnapshots(
  () => props.portfolioId,
  listQuery,
);
const deleteMutation = useDeleteSnapshot();
const resetMutation = useResetSnapshot();

const items = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 系统自动计算值（AL-054 · Q-1甲）：直接读列表行内 derivedTotalAsset（后端已实时回填） */
function systemValOf(s: SnapshotResponse): number | null {
  if (s.derivedTotalAsset == null) return null;
  const n = Number(s.derivedTotalAsset);
  return Number.isFinite(n) ? n : null;
}

// 差异提示条统计（SNAP-P0-07 / F5）：以当前列表行为准（分页 20 条/页），
// 系统值取行内 derivedTotalAsset（后端实时值，非 NAV x 份额近似）。
const navMap = computed(() => {
  const m = new Map<string, number>();
  for (const s of items.value) {
    if (s.derivedTotalAsset != null) {
      const n = Number(s.derivedTotalAsset);
      if (Number.isFinite(n)) m.set(s.date, n);
    }
  }
  return m;
});
const manualStats = computed(() =>
  computeManualDiffStats(items.value, navMap.value),
);

/** 行差异率（仅手工行且有系统值时计算） */
function diffRateOf(s: SnapshotResponse): number | null {
  const manual = s.source === 'MANUAL';
  const systemVal = systemValOf(s);
  const totalAssetNum = Number(s.totalAsset) || 0;
  return manual && systemVal !== null && systemVal !== 0
    ? (totalAssetNum - systemVal) / systemVal
    : null;
}

function resetFilters(): void {
  // 重置 = 用户主动改范围，必须标记交互，否则会被偏好对齐 watch 二次覆盖
  markInteracted();
  // 回到「偏好默认范围」而非空：页面层 query 本就带偏好默认起止，
  // 若这里清空，控件显示「不限」但实际查询仍按默认范围过滤 → 回显与结果不一致。
  const resolved = resolveQuickRange(defaultRange.value, {
    allRangeStart: baseDate.value ?? undefined,
  });
  filterQuick.value = defaultRange.value;
  filterStart.value = resolved.startDate;
  filterEnd.value = resolved.endDate;
  autoChecked.value = true;
  manualChecked.value = true;
  page.value = 1;
}

/** [仅看手工] 切换：非手工过滤 → 仅手工；已仅手工 → 恢复全部 */
function toggleManualOnly(): void {
  if (!autoChecked.value && manualChecked.value) {
    autoChecked.value = true;
    manualChecked.value = true;
  } else {
    autoChecked.value = false;
    manualChecked.value = true;
  }
}

function handleRangeChange(r: {
  startDate: string;
  endDate: string;
  quick?: string;
}): void {
  markInteracted();
  filterQuick.value = r.quick ?? '';
  filterStart.value = r.startDate;
  filterEnd.value = r.endDate;
}

function handleConfirmDelete(): void {
  if (deleting.value) {
    const target = deleting.value;
    deleteMutation.mutate(
      { portfolioId: props.portfolioId, id: target.id },
      { onSettled: () => (deleting.value = null) },
    );
  }
}

function handleConfirmReset(): void {
  if (resetting.value) {
    const target = resetting.value;
    resetMutation.mutate(
      { portfolioId: props.portfolioId, date: target.date },
      { onSettled: () => (resetting.value = null) },
    );
  }
}

/**
 * 确认弹窗关闭时延迟清空目标 ref（删除 / 重置共用）。
 *
 * reka-ui AlertDialogAction（内部 DialogClose）的关闭 handler 与用户 @click 按
 * [reka, user] 顺序合并执行：reka 先 onOpenChange(false) 再跑用户 handler。
 * 若同步清空目标 ref，用户确认 handler 执行时目标已被清空，mutation 拿不到参数
 * （对齐 PortfolioManagementCard 的删除模式）。
 */
function clearOnClose(target: Ref<SnapshotResponse | null>): void {
  queueMicrotask(() => (target.value = null));
}

function handleDeleteDialogOpenChange(o: boolean): void {
  if (!o) clearOnClose(deleting);
}

function handleResetDialogOpenChange(o: boolean): void {
  if (!o) clearOnClose(resetting);
}
</script>

<template>
  <div :class="props.class">
    <!-- 差异提示条（SNAP-P0-07 ⑥） -->
    <div
      v-if="manualStats.manualCount > 0"
      class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
    >
      <AlertTriangle class="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span>
        当前有 {{ manualStats.manualCount }} 条手工记录，其中
        {{ manualStats.diffOverThresholdCount }} 条与自动值差异 &gt; 1%
      </span>
      <Button
        size="sm"
        variant="outline"
        class="h-6 px-2 text-xs"
        title="筛选手工记录（再点一次恢复全部）"
        @click="toggleManualOnly"
      >
        {{ !autoChecked && manualChecked ? '显示全部' : '仅看手工' }}
      </Button>
    </div>

    <!-- 筛选行（SNAP-P0-04b 验收 2）：快捷范围 + 日期范围 + 来源 checkbox + [重置] -->
    <div class="mb-3 flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
      <!-- 问题⑤：接入共享快捷范围控件，与出入金页同一实现、同一高度 -->
      <DateRangeQuickPicker
        :quick="filterQuick"
        :start-date="filterStart"
        :end-date="filterEnd"
        :all-range-start="baseDate"
        @change="handleRangeChange"
      />
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">来源</Label>
        <div class="flex items-center gap-4 pb-1">
          <label class="flex items-center gap-1.5 text-sm">
            <input
              v-model="autoChecked"
              type="checkbox"
              class="h-3.5 w-3.5"
            />
            自动
          </label>
          <label class="flex items-center gap-1.5 text-sm">
            <input
              v-model="manualChecked"
              type="checkbox"
              class="h-3.5 w-3.5"
            />
            手工
          </label>
        </div>
      </div>
      <Button variant="outline" size="sm" @click="resetFilters">
        重置
      </Button>
    </div>

    <div v-if="isLoading" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" class="h-12 w-full" />
    </div>
    <div v-else-if="isError" class="py-10 text-center text-sm text-muted-foreground">
      加载失败，请稍后重试
    </div>
    <div v-else-if="items.length === 0" class="py-10 text-center text-sm text-muted-foreground">
      {{ props.emptyText }}
    </div>
    <div v-else class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-[100px]">日期</TableHead>
            <TableHead class="text-right">总资产</TableHead>
            <TableHead class="text-right">持仓</TableHead>
            <TableHead class="text-right">现金</TableHead>
            <TableHead class="w-[90px]">来源</TableHead>
            <TableHead>系统自动值（差异）</TableHead>
            <TableHead class="w-[110px]">备注</TableHead>
            <TableHead class="w-[110px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="s in items" :key="s.id">
            <TableCell class="whitespace-nowrap font-mono text-sm tabular-nums">
              {{ formatDate(s.date) }}
            </TableCell>
            <TableCell class="whitespace-nowrap text-right font-mono tabular-nums">
              {{ formatCurrency(s.totalAsset, 2, fmtOpts) }}
            </TableCell>
            <TableCell class="whitespace-nowrap text-right font-mono text-sm tabular-nums">
              {{ s.marketValue !== null ? formatCurrency(s.marketValue, 2, fmtOpts) : '-' }}
            </TableCell>
            <TableCell class="whitespace-nowrap text-right font-mono text-sm tabular-nums">
              {{ s.cashBalance !== null ? formatCurrency(s.cashBalance, 2, fmtOpts) : '-' }}
            </TableCell>
            <TableCell>
              <Badge
                v-if="s.source === 'MANUAL'"
                variant="secondary"
                class="bg-up-soft text-up"
              >
                手工
              </Badge>
              <Badge v-else variant="outline">自动</Badge>
            </TableCell>
            <TableCell class="text-sm">
              <template v-if="s.source === 'MANUAL'">
                <span v-if="systemValOf(s) !== null" class="text-muted-foreground">
                  系统 {{ formatCurrency(systemValOf(s)!, 2, fmtOpts) }}
                  <span
                    :class="
                      diffRateOf(s) !== null && diffRateOf(s)! >= 0
                        ? 'ml-1 text-up'
                        : 'ml-1 text-down'
                    "
                  >
                    （{{
                      diffRateOf(s) !== null
                        ? formatAmountChange(Number(s.totalAsset) || 0, systemValOf(s)!, 2, fmtOpts)
                        : '-'
                    }}）
                  </span>
                </span>
                <span v-else class="text-muted-foreground">-</span>
              </template>
              <span v-else class="text-xs text-muted-foreground">系统计算</span>
            </TableCell>
            <TableCell class="max-w-[100px] truncate text-sm text-muted-foreground">
              {{ s.note || '-' }}
            </TableCell>
            <TableCell class="whitespace-nowrap text-right">
              <div class="flex justify-end gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  title="编辑（变手工）"
                  @click="emit('edit', s)"
                >
                  <Pencil class="h-4 w-4" />
                </Button>
                <Button
                  v-if="s.source === 'MANUAL'"
                  size="icon"
                  variant="ghost"
                  title="重置为系统自动值"
                  @click="resetting = s"
                >
                  <RotateCcw class="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="删除"
                  @click="deleting = s"
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
    <Pagination
      v-if="!isLoading && !isError && total > 0"
      :page="page"
      :total-pages="totalPages"
      :total="total"
      @page-change="(p: number) => (page = p)"
    />

    <!-- 删除确认（SNAP-P0-06 ⑤⑥：删除这条记录，事件日系统会重新生成自动值） -->
    <AlertDialog :open="Boolean(deleting)" @update:open="handleDeleteDialogOpenChange">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该条资产记录？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后，若该日为事件日（有交易/余额/价格数据）将自动重新生成系统计算值；
            否则该日记录将被移除，并从该日期起的净值与 XIRR 将被重算。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleteMutation.isPending.value">
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="deleteMutation.isPending.value"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="handleConfirmDelete"
          >
            <Loader2
              v-if="deleteMutation.isPending.value"
              class="mr-2 h-4 w-4 animate-spin"
            />
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 重置确认（SNAP-P0-07：撤销手工修改，恢复系统计算值 + 将恢复值展示） -->
    <AlertDialog :open="Boolean(resetting)" @update:open="handleResetDialogOpenChange">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>重置为系统自动计算值？</AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="resetting">
              {{ formatDate(resetting.date) }} 的手工记录将被系统自动计算值取代，无法撤销。
              <template v-if="systemValOf(resetting) !== null">
                将恢复为系统自动计算值
                {{ formatCurrency(systemValOf(resetting)!, 2, fmtOpts) }}。
              </template>
            </template>
            <template v-else>
              手工记录将被系统自动计算值取代，无法撤销。
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="resetMutation.isPending.value">
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="resetMutation.isPending.value"
            @click="handleConfirmReset"
          >
            <Loader2
              v-if="resetMutation.isPending.value"
              class="mr-2 h-4 w-4 animate-spin"
            />
            确认重置
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
