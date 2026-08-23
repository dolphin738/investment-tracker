<script setup lang="ts">
/**
 * modules/admin/pages/LogCenterPage.vue — 全站日志中心（聚合只读视图）
 *
 * 路由：/admin/logs（name: admin-logs，菜单「系统管理 → 日志中心」，admin/auditor 可见）。
 * 数据来源：后端 GET /api/admin/logs（聚合 app_logs + notifications + job_run_logs）。
 *
 * 功能：时间范围 + 级别 + 作用域 + 模块 + 关键字筛选；列表（级别/来源/作用域色标徽标、
 * 消息摘要，未读通知带圆点）+ 分页 + 详情弹窗（堆栈/附加信息可展开）。
 * 删除：批量/单行删除（仅 admin），支持当前页全选与跨页全选；未读通知由后端跳过并计入 skipped。
 *
 * 鉴权：useHasRole('admin','auditor') 双重门控（菜单已过滤，此处防直达深链 403 兜底）。
 */
import { computed, reactive, ref, type ComponentPublicInstance } from 'vue';
import {
  Loader2,
  RotateCcw,
  ScrollText,
  Search,
  Trash2,
} from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import Pagination from '@/components/common/Pagination.vue';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariants } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  LogItem,
  LogLevel,
  LogScope,
  LogDeleteParams,
  LogListQuery,
} from '@/api/log-center.api';
import { useHasRole, useIsAdmin } from '@/stores/auth.store';
import { useLogCenter, useLogDetail, useDeleteLogs } from '../composables/use-log-center';

const PAGE_SIZE = 20;

/** 角色门控（菜单已过滤，此处防直达深链） */
const canView = useHasRole('admin', 'auditor');

// ---------------------------------------------------------------------------
// 筛选条件（响应式）
// ---------------------------------------------------------------------------
const LEVEL_OPTIONS = [
  { value: 'all', label: '全部级别' },
  { value: 'error', label: '错误' },
  { value: 'warning', label: '警告' },
  { value: 'info', label: '信息' },
] as const;

const SCOPE_OPTIONS = [
  { value: 'all', label: '全部作用域' },
  { value: 'operation', label: '业务操作' },
  { value: 'error', label: '运行错误' },
  { value: 'system', label: '系统' },
] as const;

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
  if (filters.level !== 'all') q.level = filters.level as LogLevel;
  if (filters.scope !== 'all') q.scope = filters.scope as LogScope;
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

// 当前页已选行数（用于表头 checkbox 三态：全选 / 半选 / 未选）
const pageSelectedCount = computed(
  () => items.value.filter((l) => selectedIds.value.has(l.id)).length,
);
const allPageSelected = computed(
  () => items.value.length > 0 && pageSelectedCount.value === items.value.length,
);
const somePageSelected = computed(
  () => pageSelectedCount.value > 0 && pageSelectedCount.value < items.value.length,
);
/** 表头 checkbox 的 DOM 半选态（indeterminate 非受控，须直设 DOM） */
function setHeaderIndeterminate(
  el: Element | ComponentPublicInstance | null,
): void {
  if (el instanceof HTMLInputElement) {
    el.indeterminate = !selectAll.value && somePageSelected.value;
  }
}
/** 行 checkbox 的 DOM 半选态（行恒无半选，仅保证 ref 集合触发） */
function noopRef(el: Element | ComponentPublicInstance | null): void {
  void el; /* 空实现：仅占位，避免 :ref 数组重复触发 */
}

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
  if (filters.level !== 'all') p.level = filters.level as LogLevel;
  if (filters.scope !== 'all') p.scope = filters.scope as LogScope;
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

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------
type BadgeVariant = NonNullable<BadgeVariants['variant']>;

function levelVariant(level: string | null): BadgeVariant {
  if (level === 'error') return 'destructive';
  if (level === 'warning') return 'secondary';
  return 'outline';
}
function levelLabel(level: string | null): string {
  if (level === 'error') return '错误';
  if (level === 'warning') return '警告';
  if (level === 'info') return '信息';
  return level ?? '-';
}
function sourceVariant(source: string | null): BadgeVariant {
  if (source === 'app') return 'default';
  if (source === 'notification') return 'secondary';
  return 'outline';
}
function sourceLabel(source: string | null): string {
  if (source === 'app') return '应用';
  if (source === 'notification') return '通知';
  if (source === 'job') return '任务';
  return source ?? '-';
}
function scopeVariant(scope: string | null): BadgeVariant {
  if (scope === 'error') return 'destructive';
  if (scope === 'system') return 'secondary';
  return 'outline';
}
function scopeLabel(scope: string | null): string {
  if (scope === 'operation') return '业务操作';
  if (scope === 'error') return '运行错误';
  if (scope === 'system') return '系统';
  if (scope === 'client') return '客户端';
  if (scope === 'notification') return '通知';
  if (scope === 'job') return '任务';
  return scope ?? '-';
}

/** 本地时间格式化：YYYY-MM-DD HH:mm:ss */
function formatDateTime(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** detail 字段安全 JSON 化（用于展示结构化附加信息） */
function stringifyDetail(detail: unknown): string {
  if (detail == null) return '';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
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
      <Card>
        <CardContent class="space-y-4 pt-6">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div class="space-y-2">
              <Label>级别</Label>
              <Select v-model="filters.level">
                <SelectTrigger><SelectValue placeholder="全部级别" /></SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in LEVEL_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label>作用域</Label>
              <Select v-model="filters.scope">
                <SelectTrigger><SelectValue placeholder="全部作用域" /></SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in SCOPE_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label for="log-module">模块</Label>
              <Input id="log-module" v-model="filters.module" placeholder="如 scheduler / api" />
            </div>

            <div class="space-y-2">
              <Label for="log-keyword">关键字</Label>
              <Input id="log-keyword" v-model="filters.keyword" placeholder="匹配消息内容" />
            </div>

            <div class="space-y-2">
              <Label for="log-start">开始日期</Label>
              <Input id="log-start" v-model="filters.startDate" type="date" />
            </div>

            <div class="space-y-2">
              <Label for="log-end">结束日期</Label>
              <Input id="log-end" v-model="filters.endDate" type="date" />
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" @click="onSearch">
                <Search class="mr-1 h-4 w-4" />
                查询
              </Button>
              <Button size="sm" variant="outline" @click="resetFilters">
                <RotateCcw class="mr-1 h-4 w-4" />
                重置
              </Button>
              <!-- 跨页全选：紧挨「重置」（仅管理员可见，选中态不显示当页全选入口） -->
              <Button
                v-if="isAdmin && !selectAll"
                variant="link"
                size="sm"
                class="px-0 text-muted-foreground"
                @click="selectAll = true"
              >
                全选全部 {{ total }} 条（跨页）
              </Button>
              <span
                v-if="!selectAll && selectedIds.size > 0"
                class="shrink-0 text-xs text-muted-foreground"
              >
                已选 {{ selectedIds.size }} 条
                <template v-if="selectedPages.size > 1">（跨 {{ selectedPages.size }} 页）</template>
              </span>
              <!-- 跨页全选提示条：紧跟「全选全部」（仅管理员下全选后显示） -->
              <div
                v-if="isAdmin && selectAll"
                class="flex shrink-0 items-center gap-2 rounded-md border border-dashed bg-muted/40 px-2 py-1 text-sm"
              >
                <span>已全选全部 {{ total }} 条日志（跨所有页，应用当前筛选条件）</span>
                <Button
                  variant="link"
                  size="sm"
                  class="px-0"
                  @click="selectAll = false"
                >
                  取消全选
                </Button>
              </div>
            </div>
            <!-- 删除：置顶一行最右侧（仅管理员显示） -->
            <Button
              v-if="isAdmin"
              variant="outline"
              size="sm"
              :disabled="!selectAll && selectedIds.size === 0"
              class="shrink-0 text-red-600 hover:text-red-700"
              @click="openBatchDelete"
            >
              <Trash2 class="mr-1 h-3.5 w-3.5" />
              删除({{ selectAll ? total : selectedIds.size }})
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- 列表 -->
      <Card>
        <CardContent>
          <TableSkeleton v-if="isLoading" :rows="8" :cols="7" class="py-2" />
          <EmptyState
            v-else-if="isError"
            title="日志加载失败"
            :description="errorMessage || '请稍后重试'"
          />
          <EmptyState
            v-else-if="items.length === 0"
            title="暂无日志记录"
            description="当前筛选条件下没有匹配的日志；可调整筛选或重置后重试"
          />
          <div v-else>
            <Table class="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead class="sticky left-0 z-10 w-12 bg-background">
                    <input
                      type="checkbox"
                      class="h-4 w-4 rounded border-input accent-primary"
                      :checked="selectAll || allPageSelected"
                      :ref="setHeaderIndeterminate"
                      @change="
                        ($event) =>
                          handleHeaderSelect(($event.target as HTMLInputElement).checked)
                      "
                    />
                  </TableHead>
                  <TableHead class="w-[170px] whitespace-nowrap">时间</TableHead>
                  <TableHead class="w-[90px] whitespace-nowrap">级别</TableHead>
                  <TableHead class="w-[90px] whitespace-nowrap">来源</TableHead>
                  <TableHead class="w-[110px] whitespace-nowrap">作用域</TableHead>
                  <TableHead class="w-[140px] whitespace-nowrap">模块</TableHead>
                  <TableHead>消息</TableHead>
                  <TableHead class="w-[80px] whitespace-nowrap text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="item in items"
                  :key="item.id"
                  :class="selectAll || selectedIds.has(item.id) ? 'bg-muted/40' : ''"
                >
                  <TableCell class="sticky left-0 z-10 bg-background align-middle">
                    <input
                      type="checkbox"
                      class="h-4 w-4 rounded border-input accent-primary"
                      :checked="selectAll || selectedIds.has(item.id)"
                      :disabled="selectAll"
                      :ref="noopRef"
                      @change="
                        ($event) =>
                          handleRowSelect(item, ($event.target as HTMLInputElement).checked)
                      "
                    />
                  </TableCell>
                  <TableCell class="whitespace-nowrap align-middle text-xs">
                    {{ formatDateTime(item.created_at) }}
                  </TableCell>
                  <TableCell class="align-middle">
                    <Badge :variant="levelVariant(item.level ?? null)">
                      {{ levelLabel(item.level ?? null) }}
                    </Badge>
                  </TableCell>
                  <TableCell class="align-middle">
                    <Badge :variant="sourceVariant(item.source)" class="whitespace-nowrap">
                      {{ sourceLabel(item.source) }}
                    </Badge>
                  </TableCell>
                  <TableCell class="align-middle">
                    <Badge :variant="scopeVariant(item.scope ?? null)" class="whitespace-nowrap">
                      {{ scopeLabel(item.scope ?? null) }}
                    </Badge>
                  </TableCell>
                  <TableCell class="truncate align-middle text-xs" :title="item.module ?? ''">
                    {{ item.module ?? '-' }}
                  </TableCell>
                  <TableCell class="truncate align-middle text-sm" :title="item.message ?? ''">
                    <span
                      v-if="item.source === 'notification' && item.read === false"
                      class="mr-1 inline-block h-2 w-2 rounded-full bg-primary align-middle"
                      title="未读"
                    />
                    {{ item.message ?? '-' }}
                  </TableCell>
                  <TableCell class="text-right align-middle">
                    <div class="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" @click="openDetail(item)">
                        <ScrollText class="mr-1 h-3.5 w-3.5" />
                        详情
                      </Button>
                      <Button
                        v-if="isAdmin"
                        variant="ghost"
                        size="icon"
                        title="删除"
                        class="text-red-600 hover:text-red-700"
                        @click="openSingleDelete(item)"
                      >
                        <Trash2 class="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <!-- 分页 -->
            <Pagination
              v-if="total > 0"
              :page="page"
              :total-pages="totalPages"
              :total="total"
              show-first-last
              show-jumper
              @page-change="(p: number) => (page = p)"
            />
          </div>
        </CardContent>
      </Card>
    </template>

    <!-- 删除确认弹窗（仅管理员调用；批量/单行共用） -->
    <AlertDialog v-if="isAdmin" :open="confirmOpen" @update:open="confirmOpen = !!$event">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除日志</AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="confirmPayload?.all">
              将删除当前筛选条件下全部 {{ total }} 条日志（跨所有页）；其中未读通知会被跳过。
            </template>
            <template v-else>
              将删除 {{ confirmPayload?.ids?.length ?? 0 }} 条日志；其中未读通知会被跳过。
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleteMut.isPending.value">取消</AlertDialogCancel>
          <AlertDialogAction
            class="bg-red-600 hover:bg-red-700"
            :disabled="deleteMut.isPending.value"
            @click="handleConfirmDelete"
          >
            {{ deleteMut.isPending.value ? '删除中…' : '删除' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 详情弹窗 -->
    <Dialog :open="detailId !== null" @update:open="(v: boolean) => !v && closeDetail()">
      <DialogContent class="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>日志详情</DialogTitle>
          <DialogDescription>
            {{ detail ? formatDateTime(detail.created_at) : '加载中…' }}
          </DialogDescription>
        </DialogHeader>

        <div
          v-if="detailLoading"
          class="flex items-center justify-center py-10 text-muted-foreground"
        >
          <Loader2 class="h-5 w-5 animate-spin" />
        </div>

        <div v-else-if="detail" class="space-y-4 text-sm">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <div class="mb-1 text-xs text-muted-foreground">来源</div>
              <Badge :variant="sourceVariant(detail.source)" class="whitespace-nowrap">
                {{ sourceLabel(detail.source) }}
              </Badge>
            </div>
            <div>
              <div class="mb-1 text-xs text-muted-foreground">级别</div>
              <Badge :variant="levelVariant(detail.level ?? null)">
                {{ levelLabel(detail.level ?? null) }}
              </Badge>
            </div>
            <div>
              <div class="mb-1 text-xs text-muted-foreground">作用域</div>
              <Badge :variant="scopeVariant(detail.scope ?? null)" class="whitespace-nowrap">
                {{ scopeLabel(detail.scope ?? null) }}
              </Badge>
            </div>
            <div>
              <div class="mb-1 text-xs text-muted-foreground">模块</div>
              <div class="truncate" :title="detail.module ?? ''">{{ detail.module ?? '-' }}</div>
            </div>
            <div>
              <div class="mb-1 text-xs text-muted-foreground">用户</div>
              <div class="truncate" :title="detail.user_id ?? ''">
                {{ detail.user_id ?? '系统' }}
              </div>
            </div>
            <div v-if="detail.source === 'notification'">
              <div class="mb-1 text-xs text-muted-foreground">已读</div>
              <div>{{ detail.read ? '已读' : '未读' }}</div>
            </div>
          </div>

          <div>
            <div class="mb-1 text-xs text-muted-foreground">消息</div>
            <div class="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3">
              {{ detail.message ?? '-' }}
            </div>
          </div>

          <div v-if="detail.trace">
            <div class="mb-1 text-xs text-muted-foreground">堆栈</div>
            <pre
              class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs"
            >{{ detail.trace }}</pre>
          </div>

          <div v-if="detail.detail != null">
            <div class="mb-1 text-xs text-muted-foreground">附加信息</div>
            <pre
              class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs"
            >{{ stringifyDetail(detail.detail) }}</pre>
          </div>
        </div>

        <div v-else class="py-10 text-center text-sm text-muted-foreground">
          详情加载失败或不存在
        </div>

        <DialogFooter>
          <Button variant="outline" @click="closeDetail">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
