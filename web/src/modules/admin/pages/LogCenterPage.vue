<script setup lang="ts">
/**
 * modules/admin/pages/LogCenterPage.vue — 全站日志中心（聚合只读视图）
 *
 * 路由：/admin/logs（name: admin-logs，菜单「系统管理 → 日志中心」，admin/auditor 可见）。
 * 数据来源：后端 GET /api/admin/logs（聚合 app_logs + notifications + job_run_logs）。
 *
 * 功能：时间范围 + 级别 + 作用域 + 模块 + 关键字筛选；列表（级别/来源/作用域色标徽标、
 * 消息摘要，未读通知带圆点）+ 分页 + 详情弹窗（堆栈/附加信息可展开）。无写操作
 * （自动清理由后端 LOG_CLEANUP 系统任务负责，非页面动作）。
 *
 * 鉴权：useHasRole('admin','auditor') 双重门控（菜单已过滤，此处防直达深链 403 兜底）。
 */
import { computed, reactive, ref } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RotateCcw,
  ScrollText,
  Search,
} from 'lucide-vue-next';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
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
import type { LogItem, LogLevel, LogScope, LogListQuery } from '@/api/log-center.api';
import { useHasRole } from '@/stores/auth.store';
import { useLogCenter, useLogDetail } from '../composables/use-log-center';

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
}
function goPrev(): void {
  page.value = Math.max(1, page.value - 1);
}
function goNext(): void {
  page.value = Math.min(totalPages.value, page.value + 1);
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

          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" @click="onSearch">
              <Search class="mr-1 h-4 w-4" />
              查询
            </Button>
            <Button size="sm" variant="outline" @click="resetFilters">
              <RotateCcw class="mr-1 h-4 w-4" />
              重置
            </Button>
            <span class="ml-auto text-xs text-muted-foreground">
              共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页
            </span>
          </div>
        </CardContent>
      </Card>

      <!-- 列表 -->
      <Card>
        <CardContent>
          <TableSkeleton v-if="isLoading" :rows="8" :cols="6" class="py-2" />
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
                <TableRow v-for="item in items" :key="item.id">
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
                    <Button variant="ghost" size="sm" @click="openDetail(item)">
                      <ScrollText class="mr-1 h-3.5 w-3.5" />
                      详情
                    </Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <!-- 分页 -->
            <div
              v-if="total > 0"
              class="flex items-center justify-between pt-3"
            >
              <span class="text-xs text-muted-foreground">
                共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页
              </span>
              <div class="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="page <= 1"
                  @click="goPrev"
                >
                  <ChevronLeft class="h-4 w-4" />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="page >= totalPages"
                  @click="goNext"
                >
                  下一页
                  <ChevronRight class="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </template>

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
