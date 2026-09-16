<script setup lang="ts">
/**
 * modules/admin/pages/LogCenterPage.vue — 全站日志中心（聚合只读视图，门面）
 *
 * 路由：/admin/logs（name: admin-logs，菜单「系统管理 → 日志中心」，admin/auditor 可见）。
 * 数据来源：后端 GET /api/admin/logs（聚合 app_logs + notifications + job_run_logs）。
 *
 * 功能：时间范围 + 级别 + 作用域 + 模块 + 关键字筛选；列表（级别/来源/作用域色标徽标、
 * 消息摘要，未读通知带圆点）+ 分页 + 详情弹窗（堆栈/附加信息可展开）。
 * 删除：批量/单行删除（仅 admin），支持当前页全选与跨页全选；未读通知由后端跳过并计入 skipped。
 *
 * 鉴权：useHasRole('admin','auditor') 双重门控（菜单已过滤，此处防直达深链 403 兜底）。
 *
 * 拆分结构（本文件为门面，纯位置性拆分，零行为变更）：
 * - components/LogCenterFilterBar      筛选区（filters 同引用下传 + selectAll 上抛）
 * - components/LogCenterTable          列表表格（数据 / 加载态 / 已选态下传，勾选与翻页上抛）
 * - components/LogCenterDeleteDialog   批量/单行删除确认弹窗（confirm 上抛，门面执行 mutation）
 * - components/LogCenterDetailDialog   详情弹窗（detail / detailLoading 下传，close 上抛）
 *
 * 数据获取查询（useLogCenter / useLogDetail / useDeleteLogs）全部留在本门面：
 * 子组件仅在数据抵达后挂载/渲染，若将 query 迁入子组件会因 enabled 时机错位而“死锁”。
 */
import { computed, reactive, ref } from 'vue';
import { toast } from '@/composables/use-toast';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import { Card, CardContent } from '@/components/ui/card';
import {
  type LogDeleteParams,
  type LogItem,
  type LogListQuery,
} from '@/api/log-center.api';
import { useHasRole, useIsAdmin } from '@/stores/auth.store';
import { useLogCenter, useLogDetail, useDeleteLogs } from '../composables/use-log-center';
import LogCenterFilterBar from '@/modules/admin/components/LogCenterFilterBar.vue';
import LogCenterTable from '@/modules/admin/components/LogCenterTable.vue';
import LogCenterDeleteDialog from '@/modules/admin/components/LogCenterDeleteDialog.vue';
import LogCenterDetailDialog from '@/modules/admin/components/LogCenterDetailDialog.vue';

const PAGE_SIZE = 20;

/** 角色门控（菜单已过滤，此处防直达深链） */
const canView = useHasRole('admin', 'auditor');

// ---------------------------------------------------------------------------
// 筛选条件（响应式）
// ---------------------------------------------------------------------------
const filters = reactive({
  level: 'all',
  scope: 'all',
  module: '',
  keyword: '',
  startDate: '',
  endDate: '',
});
const page = ref(1);

/** 由筛选状态推导后端查询参数（仅携带非空条件；日期转为含时分以包含整天） */
const query = computed<LogListQuery>(() => {
  const q: LogListQuery = { page: page.value, pageSize: PAGE_SIZE };
  if (filters.level !== 'all') q.level = filters.level as LogListQuery['level'];
  if (filters.scope !== 'all') q.scope = filters.scope as LogListQuery['scope'];
  const moduleKw = filters.module.trim();
  if (moduleKw) q.module = moduleKw;
  const keyword = filters.keyword.trim();
  if (keyword) q.keyword = keyword;
  if (filters.startDate) q.start = `${filters.startDate}T00:00:00`;
  if (filters.endDate) q.end = `${filters.endDate}T23:59:59`;
  return q;
});

const { data, isLoading, isError, error } = useLogCenter(query);
const items = computed<LogItem[]>(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const errorMessage = computed(() =>
  error.value instanceof Error
    ? error.value.message
    : error.value
      ? String(error.value)
      : '',
);

function onSearch(): void {
  page.value = 1;
}
function resetFilters(): void {
  filters.level = 'all';
  filters.scope = 'all';
  filters.module = '';
  filters.keyword = '';
  filters.startDate = '';
  filters.endDate = '';
  page.value = 1;
  // 重置筛选的同时清空选择（跨页全选 / 当页勾选一并取消）
  resetSelection();
}

// ---------------------------------------------------------------------------
// 删除（批量/单行）：仅管理员可用；删除权限与读取守卫不同（require_admin）
// ---------------------------------------------------------------------------
const isAdmin = useIsAdmin();
const deleteMut = useDeleteLogs();
const selectedIds = ref<Set<string>>(new Set());
const confirmOpen = ref(false);
const confirmPayload = ref<LogDeleteParams | null>(null);
const selectAll = ref(false);
/** 跨页选择：记录哪些页存在已选行（用于「已选 X 条（跨 Y 页）」提示） */
const selectedPages = ref<Set<number>>(new Set());

function resetSelection(): void {
  selectedIds.value = new Set();
  selectAll.value = false;
  selectedPages.value = new Set();
}

/** 表头全选（合并模式）：仅在当前页范围内增删，不影响其它页已选 */
function handleHeaderSelect(v: boolean): void {
  if (selectAll.value) {
    selectAll.value = false;
    return;
  }
  const n = new Set(selectedIds.value);
  if (v) items.value.forEach((l) => n.add(l.id));
  else items.value.forEach((l) => n.delete(l.id));
  selectedIds.value = n;
  const pn = new Set(selectedPages.value);
  if (v) pn.add(page.value);
  else pn.delete(page.value);
  selectedPages.value = pn;
}

/** 单行勾选：登记所属页；取消时仅当本页无其它已选才移除页面标记 */
function handleRowSelect(l: LogItem, v: boolean): void {
  const n = new Set(selectedIds.value);
  if (v) n.add(l.id);
  else n.delete(l.id);
  selectedIds.value = n;
  const pn = new Set(selectedPages.value);
  if (v) {
    pn.add(page.value);
  } else {
    const stillOnPage = items.value.some((it) => it.id !== l.id && n.has(it.id));
    if (!stillOnPage) pn.delete(page.value);
  }
  selectedPages.value = pn;
}

/** 由筛选状态推导删除过滤条件（跨页全选时传回，与 query 保持一致） */
function buildDeleteFilters(): LogDeleteParams {
  const p: LogDeleteParams = {};
  if (filters.level !== 'all') p.level = filters.level as LogListQuery['level'];
  if (filters.scope !== 'all') p.scope = filters.scope as LogListQuery['scope'];
  const moduleKw = filters.module.trim();
  if (moduleKw) p.module = moduleKw;
  const keyword = filters.keyword.trim();
  if (keyword) p.keyword = keyword;
  if (filters.startDate) p.start = `${filters.startDate}T00:00:00`;
  if (filters.endDate) p.end = `${filters.endDate}T23:59:59`;
  return p;
}

function openBatchDelete(): void {
  if (selectAll.value) {
    // 跨页全选：按当前筛选条件删除全部日志
    confirmPayload.value = { all: true, ...buildDeleteFilters() };
  } else if (selectedIds.value.size > 0) {
    confirmPayload.value = { ids: Array.from(selectedIds.value) };
  } else {
    return;
  }
  confirmOpen.value = true;
}

function openSingleDelete(item: LogItem): void {
  confirmPayload.value = { ids: [item.id] };
  confirmOpen.value = true;
}

function handleConfirmDelete(): void {
  if (!confirmPayload.value) return;
  deleteMut.mutate(confirmPayload.value, {
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 条`);
      if (data.skipped.length > 0) {
        // 逐个列出跳过原因（未读通知 / 不存在），便于用户知情
        toast.warning(`已跳过 ${data.skipped.length} 条：${data.skipped.map((s) => s.reason).join('；')}`);
      }
      resetSelection();
      confirmOpen.value = false;
    },
    onError: () => {
      confirmOpen.value = false;
    },
  });
}

// ---------------------------------------------------------------------------
// 详情弹窗
// ---------------------------------------------------------------------------
const detailId = ref<string | null>(null);
const { data: detail, isLoading: detailLoading } = useLogDetail(detailId);

function openDetail(item: LogItem): void {
  detailId.value = item.id;
}
function closeDetail(): void {
  detailId.value = null;
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="日志中心"
      description="聚合展示全站应用日志、系统通知与任务执行记录，支持按时间范围、级别、作用域与关键字检索"
    />

    <!-- 角色门控：非 admin/auditor 直达时提示 -->
    <Card v-if="!canView">
      <CardContent>
        <EmptyState
          title="无权限访问该页面"
          description="日志中心仅对系统管理员与审计员开放"
        />
      </CardContent>
    </Card>

    <template v-else>
      <!-- 筛选区 -->
      <LogCenterFilterBar
        :filters="filters"
        :is-admin="isAdmin"
        :select-all="selectAll"
        :total="total"
        :selected-ids="selectedIds"
        :selected-pages="selectedPages"
        @search="onSearch"
        @reset="resetFilters"
        @batch-delete="openBatchDelete"
        @update:select-all="selectAll = $event"
      />

      <!-- 列表 -->
      <LogCenterTable
        :items="items"
        :is-loading="isLoading"
        :is-error="isError"
        :error-message="errorMessage"
        :selected-ids="selectedIds"
        :select-all="selectAll"
        :total="total"
        :total-pages="totalPages"
        :page="page"
        :is-admin="isAdmin"
        @header-select="handleHeaderSelect"
        @row-select="handleRowSelect"
        @page-change="(p: number) => (page = p)"
        @detail="openDetail"
        @single-delete="openSingleDelete"
      />
    </template>

    <!-- 删除确认弹窗（仅管理员调用；批量/单行共用） -->
    <LogCenterDeleteDialog
      :open="confirmOpen"
      :confirm-payload="confirmPayload"
      :total="total"
      :pending="deleteMut.isPending.value"
      @confirm="handleConfirmDelete"
      @update:open="confirmOpen = !!$event"
    />

    <!-- 详情弹窗 -->
    <LogCenterDetailDialog
      :open="detailId !== null"
      :detail="detail"
      :detail-loading="detailLoading"
      @close="closeDetail"
    />
  </div>
</template>
