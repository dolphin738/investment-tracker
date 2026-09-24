<script setup lang="ts">
/**
 * modules/admin/pages/PendingDividendsPage.vue — 待人工划分分红独立页（门面）
 *
 * 路由：/admin/pending-dividends（唯一入口 = 全局设置「补齐历史分红」区块的按钮；不挂侧边栏）。
 *
 * 鉴权三层退化（本项目路由层无 meta/role 机制，不为本页发明 meta）：
 * ① 页内 useHasRole('admin','auditor') 门控（读）、useIsAdmin() 门控（写）；
 * ② 所有 pending / settings 查询 enabled 门控（非授权不发请求）；
 * ③ 后端 require_admin 403 兜底。
 *
 * 交互要点（设计 §5.3.3 / §5.3.7 / §5.3.8）：
 * - 列表固定排序（后端 created_at DESC, id DESC），**不提供列头排序**。
 * - 任一筛选变化 → page=1 且清空选中；翻页同样清空（防跨筛选 / 跨页批量误操作）。
 * - 只做「本页全选」，不做跨页全选；**可勾选行口径与表格共用** `isSelectablePendingRow`（仅 PENDING）。
 * - 忽略不可撤销、且不写主表 → 二次确认；采纳建议（写主表）→ 同样二次确认。
 * - 批量部分失败：红条列前 5 条，失败行保持选中便于重试（逻辑在 usePendingDividendBatch）。
 *
 * 拆分结构（纯位置性 + 一组行为抽出，S17）：筛选区 PendingDividendFilterBar；列表
 * PendingDividendTable；批量条（结果红条 + 操作条）PendingDividendBatchBar；指定弹窗
 * PendingDividendAssignDialog；批量确认 PendingDividendBatchDialog；**批量编排**（确认态、
 * 结果态、失败保持选中、采纳预览）use-pending-batch.ts。数据获取（列表/概览/设置）与单笔
 * 「指定」表单仍留在本门面。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { components } from '@/types/api';
import type { PendingAssignPayload } from '@/api/dividend-yield.api';
import { toast } from '@/composables/use-toast';
import PageHeader from '@/components/common/PageHeader.vue';
import { Card, CardContent } from '@/components/ui/card';
import { useHasRole, useIsAdmin } from '@/stores/auth.store';
import {
  useAssignPendingDividend,
  usePendingDividendSummary,
  usePendingDividendsList,
  useReopenPendingDividend,
} from '@/modules/dividend-yield/composables/use-pending-dividends';
import { useDividendYieldSettings } from '@/modules/dividend-yield/composables/use-dividend-yield';
import { isSelectablePendingRow } from '@/modules/dividend-yield/lib/pending-dividends';
import type { PendingStatusFilter } from '@/modules/dividend-yield/lib/pending-dividends';
import { usePendingDividendBatch } from '@/modules/admin/composables/use-pending-batch';
import PendingDividendFilterBar from '@/modules/admin/components/PendingDividendFilterBar.vue';
import PendingDividendTable from '@/modules/admin/components/PendingDividendTable.vue';
import PendingDividendBatchBar from '@/modules/admin/components/PendingDividendBatchBar.vue';
import PendingDividendAssignDialog from '@/modules/admin/components/PendingDividendAssignDialog.vue';
import PendingDividendBatchDialog from '@/modules/admin/components/PendingDividendBatchDialog.vue';

type PendingDividendOut = components['schemas']['PendingDividendOut'];

const PAGE_SIZE = 20;

/** 读权限（admin/auditor）；写权限（仅 admin） */
const canView = useHasRole('admin', 'auditor');
const isAdmin = useIsAdmin();

// ── 筛选（status 默认 PENDING = 待处理视图；label 精确；q 关键字 250ms 防抖） ──
// PendingStatusFilter 收口在 lib/pending-dividends.ts（§4）：与 FilterBar 共用同一联合类型，
// 子组件不再以 string 抹平。
const filters = reactive<{ status: PendingStatusFilter; label: string; q: string }>({
  status: 'PENDING',
  label: '',
  q: '',
});
const debouncedQ = ref('');
const page = ref(1);
let qTimer: ReturnType<typeof setTimeout> | undefined;

const query = computed(() => ({
  status: filters.status || undefined,
  label: filters.label || undefined,
  q: debouncedQ.value || undefined,
  page: page.value,
  pageSize: PAGE_SIZE,
}));

const list = usePendingDividendsList(query, canView);
const summary = usePendingDividendSummary(canView);
const settings = useDividendYieldSettings(isAdmin);

const items = computed<PendingDividendOut[]>(() => list.data.value?.items ?? []);
const total = computed(() => list.data.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const errorMessage = computed(() =>
  list.error.value instanceof Error
    ? list.error.value.message
    : list.error.value
      ? String(list.error.value)
      : '',
);
/** 留存窗年数（D-4；未配置回落 5，不硬编码 cur-4） */
const retentionYears = computed(() => settings.data.value?.dividend_retention_years ?? 5);
const labelOptions = computed(() => summary.data.value?.labels ?? []);
const filterActive = computed(
  () => Boolean(filters.label) || Boolean(debouncedQ.value) || filters.status !== 'PENDING',
);

// ── 选中态（仅本页、仅可勾选行 —— 判定与表格共用 isSelectablePendingRow） ──
const selectedIds = ref<Set<string>>(new Set());
function resetSelection(): void {
  selectedIds.value = new Set();
}
const selectableRows = computed(() => items.value.filter(isSelectablePendingRow));
const selectedRows = computed(() =>
  selectableRows.value.filter((r) => selectedIds.value.has(r.id)),
);
function onHeaderSelect(v: boolean): void {
  const n = new Set(selectedIds.value);
  if (v) selectableRows.value.forEach((r) => n.add(r.id));
  else selectableRows.value.forEach((r) => n.delete(r.id));
  selectedIds.value = n;
}
function onRowSelect(row: PendingDividendOut, v: boolean): void {
  const n = new Set(selectedIds.value);
  if (v) n.add(row.id);
  else n.delete(row.id);
  selectedIds.value = n;
}

// ── 批量编排（S17 抽到 use-pending-batch：确认弹窗态 / 结果态 / 失败保持选中 / 预览） ──
const ignoreTargets = ref<string[]>([]);
const {
  confirmOpen,
  confirmMode,
  lastBatchFailed,
  lastBatchSucceeded,
  adoptablePayloads,
  skippedNoCandidate,
  assignPreview,
  batchAssignPending,
  batchIgnorePending,
  openBatchAssign,
  openBatchIgnore,
  openRowIgnore,
  confirmBatch,
} = usePendingDividendBatch({ selectedIds, selectedRows, ignoreTargets });

// ── 筛选变化 / 翻页：回到第 1 页（筛选）并清空选中 ──
function onFilterChange(): void {
  page.value = 1;
  resetSelection();
}
function onPageChange(p: number): void {
  page.value = p;
  resetSelection();
}
function resetFilters(): void {
  filters.status = 'PENDING';
  filters.label = '';
  filters.q = '';
  debouncedQ.value = '';
  onFilterChange();
}
watch(
  () => filters.q,
  (v) => {
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      debouncedQ.value = v.trim();
      onFilterChange();
    }, 250);
  },
);
onBeforeUnmount(() => {
  if (qTimer) clearTimeout(qTimer);
});

// ── 单笔指定 ──
const assignMut = useAssignPendingDividend();
const assignOpen = ref(false);
const assignRow = ref<PendingDividendOut | null>(null);
function openAssign(row: PendingDividendOut): void {
  assignRow.value = row;
  assignOpen.value = true;
}
function onAssignSubmit(payload: PendingAssignPayload): void {
  const row = assignRow.value;
  if (!row) return;
  assignMut.mutate(
    { id: row.id, payload },
    {
      onSuccess: (data) => {
        const msg = data.conflict
          ? `已指定报告期，但${data.warning || '主表同格已存在、未覆盖'}`
          : '已指定报告期并写入分红主表';
        if (data.conflict) toast.warning(msg);
        else toast.success(msg);
        assignOpen.value = false;
        assignRow.value = null;
      },
      onError: () => toast.error('指定失败，请稍后重试'),
    },
  );
}

// ── 撤销指定（D-5） ──
const reopenMut = useReopenPendingDividend();
function onReopen(row: PendingDividendOut): void {
  reopenMut.mutate(row.id, {
    onSuccess: (data) =>
      toast.success(data.rolledBack ? '已撤销划分，并删除对应主表行' : '已撤销划分'),
    onError: () => toast.error('撤销失败，请稍后重试'),
  });
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="待人工划分分红"
      description="源站「报告时间」不可解析的现金分红落于待划分区，需人工指定报告期；也可按建议值一键采纳"
    />

    <!-- 非 admin/auditor：无权限（与 GlobalSettingsPage 守卫口径一致） -->
    <Card v-if="!canView">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">
        无权限访问该页面
      </CardContent>
    </Card>

    <template v-else>
      <PendingDividendFilterBar
        :filters="filters"
        :label-options="labelOptions"
        @change="onFilterChange"
        @reset="resetFilters"
      />

      <PendingDividendBatchBar
        :succeeded="lastBatchSucceeded"
        :failed="lastBatchFailed"
        :selected-count="selectedIds.size"
        :adoptable-count="adoptablePayloads.length"
        :skipped="skippedNoCandidate"
        :assign-pending="batchAssignPending"
        :ignore-pending="batchIgnorePending"
        :is-admin="isAdmin"
        @adopt="openBatchAssign"
        @ignore="openBatchIgnore"
        @clear="resetSelection"
      />

      <Card>
        <CardContent class="pt-6">
          <PendingDividendTable
            :items="items"
            :is-loading="list.isLoading.value"
            :is-error="list.isError.value"
            :error-message="errorMessage"
            :selected-ids="selectedIds"
            :page="page"
            :total-pages="totalPages"
            :total="total"
            :filter-active="filterActive"
            :is-admin="isAdmin"
            @header-select="onHeaderSelect"
            @row-select="onRowSelect"
            @page-change="onPageChange"
            @assign="openAssign"
            @ignore="openRowIgnore"
            @reopen="onReopen"
            @retry="() => list.refetch()"
          />
        </CardContent>
      </Card>
    </template>

    <PendingDividendBatchDialog
      :open="confirmOpen"
      :mode="confirmMode"
      :adopt-count="adoptablePayloads.length"
      :selected-count="ignoreTargets.length"
      :skipped="skippedNoCandidate"
      :preview="assignPreview"
      @confirm="confirmBatch"
      @update:open="(o: boolean) => (confirmOpen = o)"
    />

    <PendingDividendAssignDialog
      :open="assignOpen"
      :row="assignRow"
      :retention-years="retentionYears"
      :pending="assignMut.isPending.value"
      @submit="onAssignSubmit"
      @update:open="(o: boolean) => (assignOpen = o)"
    />
  </div>
</template>
