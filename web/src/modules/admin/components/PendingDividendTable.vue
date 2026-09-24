<script setup lang="ts">
/**
 * modules/admin/components/PendingDividendTable.vue — 待划分分红哑表格
 *
 * 9 列：☑ ｜ 证券（sticky 首列）｜ 原文标签 ｜ 分红方案（后端 planLabel）｜ 公告日 ｜ 除权日 ｜
 *       报告期（ASSIGNED 用后端 resolvedPeriodLabel；PENDING 显示前端建议值）｜ 状态 Badge ｜
 *       操作（指定 / 忽略 / 重新划分）。
 *
 * 数据与已选态由页面（门面）下传；勾选 / 翻页 / 行操作一律经事件上抛，本组件无副作用。
 * **不提供列头排序**（后端 pending 端点未定义 sort，前端不得臆造）。
 */
import { computed, type ComponentPublicInstance } from 'vue';
import type { components } from '@/types/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariants } from '@/components/ui/badge';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import Pagination from '@/components/common/Pagination.vue';
import {
  PERIOD_TYPE_LABELS,
  suggestReportPeriod,
} from '@/modules/dividend-yield/lib/suggest-report-period';
import { isSelectablePendingRow } from '@/modules/dividend-yield/lib/pending-dividends';

type PendingDividendOut = components['schemas']['PendingDividendOut'];
type BadgeVariant = NonNullable<BadgeVariants['variant']>;

const props = defineProps<{
  /** 当前页待划分行 */
  items: PendingDividendOut[];
  /** 列表加载中 */
  isLoading: boolean;
  /** 列表加载失败 */
  isError: boolean;
  /** 失败描述 */
  errorMessage: string;
  /** 已选行 id 集合（仅本页范围） */
  selectedIds: Set<string>;
  /** 当前页码（分页控件受控） */
  page: number;
  /** 总页数 */
  totalPages: number;
  /** 总数 */
  total: number;
  /** 是否存在筛选（区分「库内无行」与「筛选无结果」两种空态） */
  filterActive: boolean;
  /** 是否管理员（写操作入口门控：指定 / 忽略 / 重新划分） */
  isAdmin: boolean;
}>();

const emit = defineEmits<{
  (e: 'header-select', v: boolean): void;
  (e: 'row-select', item: PendingDividendOut, v: boolean): void;
  (e: 'page-change', p: number): void;
  (e: 'assign', item: PendingDividendOut): void;
  (e: 'ignore', item: PendingDividendOut): void;
  (e: 'reopen', item: PendingDividendOut): void;
  (e: 'retry'): void;
}>();

// ── 可勾选口径（S10）：与门面共用 isSelectablePendingRow（仅 PENDING）──
// 表头三态**只统计可勾选行**：否则「全部」视图下（含 ASSIGNED/IGNORED 行）表头永远无法
// 进入全选态（它要求 items 全部被选中，而其中非 PENDING 行不可勾选）。
const selectableItems = computed(() => props.items.filter(isSelectablePendingRow));

// ── 表头 checkbox 三态（indeterminate 非受控，须直设 DOM） ──
const pageSelectedCount = computed(
  () => selectableItems.value.filter((r) => props.selectedIds.has(r.id)).length,
);
const allPageSelected = computed(
  () =>
    selectableItems.value.length > 0 &&
    pageSelectedCount.value === selectableItems.value.length,
);
const somePageSelected = computed(
  () =>
    pageSelectedCount.value > 0 &&
    pageSelectedCount.value < selectableItems.value.length,
);
function setHeaderIndeterminate(
  el: Element | ComponentPublicInstance | null,
): void {
  if (el instanceof HTMLInputElement) {
    el.indeterminate = somePageSelected.value;
  }
}
function noopRef(el: Element | ComponentPublicInstance | null): void {
  void el;
}

// ── 展示辅助 ──
function statusVariant(status: string): BadgeVariant {
  if (status === 'ASSIGNED') return 'success';
  if (status === 'IGNORED') return 'outline';
  return 'secondary';
}
function statusLabel(status: string): string {
  if (status === 'ASSIGNED') return '已划分';
  if (status === 'IGNORED') return '已忽略';
  if (status === 'PENDING') return '待划分';
  return status;
}

/**
 * 报告期文案：ASSIGNED 行用后端产出的 `resolvedPeriodLabel`（与证券详情页 `periodLabel`
 * 同口径，S11）；PENDING 行报告期未知，展示前端算的建议值。
 */
function suggestionLabel(row: PendingDividendOut): string {
  if (row.status === 'ASSIGNED') {
    if (row.resolvedPeriodLabel) return row.resolvedPeriodLabel;
    // 兜底：契约字段缺失（老数据 / 序列化异常）时才回退到本地拼装
    const type = (row.resolvedPeriodType ?? 'OTHER') as keyof typeof PERIOD_TYPE_LABELS;
    return `${row.resolvedReportYear ?? '?'} Q${row.resolvedReportQuarter ?? '?'} · ${PERIOD_TYPE_LABELS[type] ?? '其他'}`;
  }
  const c = suggestReportPeriod({
    dividendLabel: row.dividendLabel ?? null,
    announcementDate: row.announcementDate ?? null,
    exDividendDate: row.exDividendDate ?? null,
  })[0];
  if (!c) return '无候选，须人工';
  const approx = c.approximate ? '（除权日推定，粗略）' : '';
  return `${c.reportYear} Q${c.reportQuarter} · ${PERIOD_TYPE_LABELS[c.periodType]}${approx}`;
}
</script>

<template>
  <div class="overflow-x-auto">
    <TableSkeleton v-if="isLoading" :rows="8" :cols="9" class="py-2" />
    <ErrorState
      v-else-if="isError"
      title="待划分分红加载失败"
      :description="errorMessage || '请稍后重试'"
    >
      <template #action>
        <Button variant="outline" size="sm" class="mt-2" @click="emit('retry')">
          重试
        </Button>
      </template>
    </ErrorState>
    <EmptyState
      v-else-if="items.length === 0 && filterActive"
      title="筛选无结果"
      description="当前筛选条件下没有匹配的待划分分红；可调整筛选或重置后重试"
    />
    <EmptyState
      v-else-if="items.length === 0"
      title="暂无待划分分红"
      description="库内没有需要人工指定报告期的现金分红记录"
    />
    <template v-else>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="sticky left-0 z-20 w-10 bg-background">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-input accent-primary"
                :checked="allPageSelected"
                :disabled="selectableItems.length === 0"
                :title="
                  selectableItems.length === 0
                    ? '本页没有可勾选的待划分行（仅「待划分」状态可批量操作）'
                    : '全选本页可勾选行'
                "
                :ref="setHeaderIndeterminate"
                @change="
                  ($event) =>
                    emit('header-select', ($event.target as HTMLInputElement).checked)
                "
              />
            </TableHead>
            <TableHead class="sticky left-10 z-10 min-w-[140px] bg-background">
              证券
            </TableHead>
            <TableHead class="min-w-[96px] whitespace-nowrap">原文标签</TableHead>
            <TableHead class="min-w-[110px] whitespace-nowrap text-right">分红方案</TableHead>
            <TableHead class="min-w-[104px] whitespace-nowrap">公告日</TableHead>
            <TableHead class="min-w-[104px] whitespace-nowrap">除权日</TableHead>
            <TableHead class="min-w-[180px] whitespace-nowrap">建议报告期</TableHead>
            <TableHead class="w-[88px] whitespace-nowrap">状态</TableHead>
            <TableHead class="w-[170px] whitespace-nowrap text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="row in items"
            :key="row.id"
            :class="selectedIds.has(row.id) ? 'bg-muted/40' : ''"
          >
            <TableCell class="sticky left-0 z-20 bg-background align-middle">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                :checked="selectedIds.has(row.id)"
                :disabled="!isSelectablePendingRow(row)"
                :title="
                  isSelectablePendingRow(row)
                    ? ''
                    : '仅「待划分」状态可勾选（已划分 / 已忽略行不可批量操作）'
                "
                :ref="noopRef"
                @change="
                  ($event) =>
                    emit('row-select', row, ($event.target as HTMLInputElement).checked)
                "
              />
            </TableCell>
            <TableCell class="sticky left-10 z-10 bg-background align-middle">
              <div class="flex flex-col">
                <span class="font-mono text-sm">{{ row.code || '未知代码' }}</span>
                <span class="text-xs text-muted-foreground">{{ row.name || '—' }}</span>
              </div>
            </TableCell>
            <TableCell class="align-middle">
              <Badge v-if="row.dividendLabel" variant="outline">
                {{ row.dividendLabel }}
              </Badge>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </TableCell>
            <TableCell
              class="whitespace-nowrap text-right align-middle font-mono tabular-nums"
              :title="`每股 ${row.cashPerShare} 元`"
            >
              {{ row.planLabel }}
            </TableCell>
            <TableCell class="whitespace-nowrap align-middle text-xs">
              {{ row.announcementDate || '—' }}
            </TableCell>
            <TableCell class="whitespace-nowrap align-middle text-xs">
              {{ row.exDividendDate || '—' }}
            </TableCell>
            <TableCell class="whitespace-nowrap align-middle text-xs">
              {{ suggestionLabel(row) }}
            </TableCell>
            <TableCell class="align-middle">
              <Badge :variant="statusVariant(row.status)">
                {{ statusLabel(row.status) }}
              </Badge>
            </TableCell>
            <TableCell class="text-right align-middle">
              <div v-if="isAdmin" class="flex items-center justify-end gap-1">
                <template v-if="row.status === 'PENDING'">
                  <Button variant="ghost" size="sm" @click="emit('assign', row)">
                    指定
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-red-600 hover:text-red-700"
                    @click="emit('ignore', row)"
                  >
                    忽略
                  </Button>
                </template>
                <Button
                  v-else-if="row.status === 'ASSIGNED'"
                  variant="ghost"
                  size="sm"
                  title="撤销划分，恢复为待划分"
                  @click="emit('reopen', row)"
                >
                  重新划分
                </Button>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </div>
              <span v-else class="text-xs text-muted-foreground">只读</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Pagination
        v-if="total > 0"
        :page="page"
        :total-pages="totalPages"
        :total="total"
        show-first-last
        show-jumper
        @page-change="(p: number) => emit('page-change', p)"
      />
    </template>
  </div>
</template>
