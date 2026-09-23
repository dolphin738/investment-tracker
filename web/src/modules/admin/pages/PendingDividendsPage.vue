<script setup lang="ts">
/**
 * modules/admin/pages/PendingDividendsPage.vue — 待人工划分分红独立页
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
 * - 只做「本页全选」，不做跨页全选。
 * - 忽略不可撤销、且不写主表 → 二次确认；采纳建议（写主表）→ 同样二次确认。
 * - 批量部分失败：页内红条列前 5 条，失败行保持选中便于重试。
 *
 * 拆分结构（纯位置性）：筛选区 PendingDividendFilterBar；列表 PendingDividendTable；
 * 指定弹窗 PendingDividendAssignDialog；批量确认 PendingDividendBatchDialog。
 * 数据获取 / mutation 全部留在本门面。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { components } from '@/types/api';
import { toast } from '@/composables/use-toast';
import PageHeader from '@/components/common/PageHeader.vue';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useHasRole, useIsAdmin } from '@/stores/auth.store';
import {
  useAssignPendingDividend,
  useBatchAssignPendingDividends,
  useBatchIgnorePendingDividends,
  useIgnorePendingDividend,
  usePendingDividendSummary,
  usePendingDividendsList,
  useReopenPendingDividend,
} from '@/modules/dividend-yield/composables/use-pending-dividends';
import { useDividendYieldSettings } from '@/modules/dividend-yield/composables/use-dividend-yield';
import {
  PERIOD_TYPE_LABELS,
  suggestReportPeriod,
} from '@/modules/dividend-yield/lib/suggest-report-period';
import PendingDividendFilterBar from '@/modules/admin/components/PendingDividendFilterBar.vue';
import PendingDividendTable from '@/modules/admin/components/PendingDividendTable.vue';
import PendingDividendAssignDialog from '@/modules/admin/components/PendingDividendAssignDialog.vue';
import PendingDividendBatchDialog from '@/modules/admin/components/PendingDividendBatchDialog.vue';

type PendingDividendOut = components['schemas']['PendingDividendOut'];
type PendingAssignPayload = { reportYear: number; reportQuarter: number; periodType: string };

const PAGE_SIZE = 20;

/** 读权限（admin/auditor）；写权限（仅 admin） */
const canView = useHasRole('admin', 'auditor');
const isAdmin = useIsAdmin();

// ── 筛选（status 默认 PENDING = 待处理视图；label 精确；q 关键字 250ms 防抖） ──
type PendingStatusFilter = '' | 'PENDING' | 'ASSIGNED' | 'IGNORED';
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

// ── 选中态（仅本页、仅 PENDING 可选） ──
const selectedIds = ref<Set<string>>(new Set());
function resetSelection(): void {
  selectedIds.value = new Set();
}
const selectableRows = computed(() => items.value.filter((r) => r.status === 'PENDING'));
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

/** 由行生成建议 payload（无候选返回 null，调用方过滤） */
function suggestionPayload(
  row: PendingDividendOut,
): (PendingAssignPayload & { id: string }) | null {
  const c = suggestReportPeriod({
    dividendLabel: row.dividendLabel ?? null,
    announcementDate: row.announcementDate ?? null,
    exDividendDate: row.exDividendDate ?? null,
  })[0];
  if (!c) return null;
  return {
    id: row.id,
    reportYear: c.reportYear,
    reportQuarter: c.reportQuarter,
    periodType: c.periodType,
  };
}

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

// ── 批量：采纳建议 / 忽略（共用确认弹窗） ──
const batchAssignMut = useBatchAssignPendingDividends();
const batchIgnoreMut = useBatchIgnorePendingDividends();
const ignoreMut = useIgnorePendingDividend();
const confirmOpen = ref(false);
const confirmMode = ref<'assign' | 'ignore'>('assign');
/** 本次忽略确认弹窗的目标 id：行内点击 = 该行 1 个；批量条 = 勾选集 */
const ignoreTargets = ref<string[]>([]);
const lastBatchFailed = ref<{ id: string; code: string; reason: string }[]>([]);
const lastBatchSucceeded = ref(0);

/** 有建议候选的选中行（采纳建议只覆盖这些；无候选行跳过） */
const adoptablePayloads = computed(() =>
  selectedRows.value
    .map(suggestionPayload)
    .filter((x): x is PendingAssignPayload & { id: string } => x !== null),
);
const skippedNoCandidate = computed(
  () => selectedRows.value.length - adoptablePayloads.value.length,
);
const assignPreview = computed(() =>
  selectedRows.value
    .map((r) => ({ r, p: suggestionPayload(r) }))
    .filter(
      (x): x is { r: PendingDividendOut; p: PendingAssignPayload & { id: string } } =>
        x.p !== null,
    )
    .slice(0, 3)
    .map(
      ({ r, p }) =>
        `${r.code || r.masterId} ${p.reportYear}Q${p.reportQuarter} ${
          PERIOD_TYPE_LABELS[p.periodType as keyof typeof PERIOD_TYPE_LABELS] ?? '其他'
        }`,
    ),
);

function openBatchAssign(): void {
  if (adoptablePayloads.value.length === 0) return;
  confirmMode.value = 'assign';
  confirmOpen.value = true;
}
function openBatchIgnore(): void {
  if (selectedIds.value.size === 0) return;
  ignoreTargets.value = Array.from(selectedIds.value);
  confirmMode.value = 'ignore';
  confirmOpen.value = true;
}
/**
 * 行内「忽略」：只忽略被点击的这一行。
 *
 * 此前该按钮 `emit('ignore', row)` 绑定的却是上面的无参批量处理函数 → row 被静默丢弃，
 * 表现为「未勾选时点了没反应」/「有勾选时忽略的是整个勾选集而非被点行」。忽略不可撤销，
 * 故单行走单笔端点（`useIgnorePendingDividend`），语义与失败提示都更准确。
 */
function openRowIgnore(row: PendingDividendOut): void {
  ignoreTargets.value = [row.id];
  confirmMode.value = 'ignore';
  confirmOpen.value = true;
}
function handleBatchResult(
  action: string,
  data: { succeeded: number; failed?: { id: string; code: string; reason: string }[] },
): void {
  lastBatchSucceeded.value = data.succeeded;
  lastBatchFailed.value = data.failed ?? [];
  if (lastBatchFailed.value.length > 0) {
    toast.warning(`${action}：成功 ${data.succeeded} 笔、失败 ${lastBatchFailed.value.length} 笔`);
  } else {
    toast.success(`${action}：全部成功（${data.succeeded} 笔）`);
  }
}
function confirmBatch(): void {
  confirmOpen.value = false;
  if (confirmMode.value === 'assign') {
    batchAssignMut.mutate(adoptablePayloads.value, {
      onSuccess: (data) => {
        handleBatchResult('采纳建议', data);
        resetSelection();
      },
      onError: () => toast.error('批量采纳失败，请稍后重试'),
    });
  } else {
    const ids = ignoreTargets.value;
    if (ids.length === 0) return;
    // 单笔（行内按钮）走单笔端点：语义清晰、失败原因更准确；多笔走批量端点（逐项报错）
    if (ids.length === 1) {
      const only = ids[0];
      ignoreMut.mutate(only, {
        onSuccess: () => {
          // 只摘掉这一行，不清空其余勾选（点行内按钮不该影响勾选集）
          const n = new Set(selectedIds.value);
          n.delete(only);
          selectedIds.value = n;
          ignoreTargets.value = [];
          toast.success('已忽略（未写入分红主表）');
        },
        onError: () => toast.error('忽略失败，请稍后重试'),
      });
      return;
    }
    batchIgnoreMut.mutate(ids, {
      onSuccess: (data) => {
        handleBatchResult('忽略', data);
        ignoreTargets.value = [];
        resetSelection();
      },
      onError: () => toast.error('批量忽略失败，请稍后重试'),
    });
  }
}
/** 失败行保持选中便于重试（已成功的行从选中集移除） */
watch(lastBatchFailed, (failed) => {
  if (failed.length === 0) return;
  selectedIds.value = new Set(failed.map((f) => f.id));
});

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

      <!-- 批量结果红条（部分失败：列前 5 条） -->
      <div
        v-if="lastBatchFailed.length > 0"
        class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
      >
        <div class="font-medium">
          上一批操作：成功 {{ lastBatchSucceeded }} 笔、失败 {{ lastBatchFailed.length }} 笔（失败行已保持选中）
        </div>
        <ul class="mt-1 list-inside list-disc text-xs">
          <li v-for="f in lastBatchFailed.slice(0, 5)" :key="f.id">
            {{ f.id }} — {{ f.code }}：{{ f.reason }}
          </li>
        </ul>
      </div>

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

      <!-- 批量操作条（sticky，非 fixed） -->
      <div
        v-if="isAdmin && selectedIds.size > 0"
        class="sticky bottom-0 z-30 flex flex-wrap items-center gap-3 rounded-md border bg-background/95 px-4 py-3 shadow-sm backdrop-blur"
      >
        <span class="text-sm">已选 {{ selectedIds.size }} 笔</span>
        <Button
          size="sm"
          :disabled="adoptablePayloads.length === 0 || batchAssignMut.isPending.value"
          :title="skippedNoCandidate > 0 ? `已跳过 ${skippedNoCandidate} 笔无候选行` : ''"
          @click="openBatchAssign"
        >
          采纳建议 ({{ adoptablePayloads.length }})
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="batchIgnoreMut.isPending.value"
          @click="openBatchIgnore"
        >
          忽略 ({{ selectedIds.size }})
        </Button>
        <Button variant="ghost" size="sm" class="ml-auto" @click="resetSelection">
          清空
        </Button>
        <span v-if="skippedNoCandidate > 0" class="text-xs text-muted-foreground">
          （已跳过 {{ skippedNoCandidate }} 笔无候选行）
        </span>
      </div>
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
