<script setup lang="ts">
/**
 * modules/admin/components/LogCenterTable.vue — 日志中心列表表格
 *
 * 从 LogCenterPage 抽出：加载骨架 / 错误空态 / 空数据空态 / 日志表格（级别/来源/作用域
 * 色标徽标、消息摘要、未读通知圆点）/ 分页 / 表头与行勾选（三态 indeterminate）。
 *
 * 数据（items / 加载态 / 总数 / 已选态）由门面下传；勾选 change 经 header-select /
 * row-select 上抛，由门面统一改 selectedIds / selectedPages；翻页经 page-change 上抛；
 * 详情 / 单行删除经 detail / single-delete 上抛。展示辅助函数（levelVariant 等）与
 * DOM 半选回调随本组件一并抽出，保持模板逐字节等价。纯位置性拆分，零行为变更。
 */
import { computed, type ComponentPublicInstance } from 'vue';
import { formatDateTime } from '@/lib/utils';
import EmptyState from '@/components/common/EmptyState.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import Pagination from '@/components/common/Pagination.vue';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariants } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollText, Trash2 } from 'lucide-vue-next';
import type { LogItem } from '@/api/log-center.api';

const props = defineProps<{
  /** 当前页日志列表 */
  items: LogItem[];
  /** 列表加载中 */
  isLoading: boolean;
  /** 列表加载失败 */
  isError: boolean;
  /** 失败描述（error 消息或兜底文案） */
  errorMessage: string;
  /** 已选行 id 集合 */
  selectedIds: Set<string>;
  /** 跨页全选态 */
  selectAll: boolean;
  /** 当前筛选结果总数 */
  total: number;
  /** 总页数 */
  totalPages: number;
  /** 当前页码（分页控件受控） */
  page: number;
  /** 是否管理员（控制单行删除入口） */
  isAdmin: boolean;
}>();

const emit = defineEmits<{
  (e: 'header-select', v: boolean): void;
  (e: 'row-select', item: LogItem, v: boolean): void;
  (e: 'page-change', p: number): void;
  (e: 'detail', item: LogItem): void;
  (e: 'single-delete', item: LogItem): void;
}>();

// ---------------------------------------------------------------------------
// 展示辅助（与门面拆分前一致，随本组件一并抽出）
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

// 当前页已选行数（用于表头 checkbox 三态：全选 / 半选 / 未选）
const pageSelectedCount = computed(
  () => props.items.filter((l) => props.selectedIds.has(l.id)).length,
);
const allPageSelected = computed(
  () => props.items.length > 0 && pageSelectedCount.value === props.items.length,
);
const somePageSelected = computed(
  () => pageSelectedCount.value > 0 && pageSelectedCount.value < props.items.length,
);
/** 表头 checkbox 的 DOM 半选态（indeterminate 非受控，须直设 DOM） */
function setHeaderIndeterminate(
  el: Element | ComponentPublicInstance | null,
): void {
  if (el instanceof HTMLInputElement) {
    el.indeterminate = !props.selectAll && somePageSelected.value;
  }
}
/** 行 checkbox 的 DOM 半选态（行恒无半选，仅保证 ref 集合触发） */
function noopRef(el: Element | ComponentPublicInstance | null): void {
  void el; /* 空实现：仅占位，避免 :ref 数组重复触发 */
}
</script>

<template>
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
                      emit('header-select', ($event.target as HTMLInputElement).checked)
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
                      emit('row-select', item, ($event.target as HTMLInputElement).checked)
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
                  <Button variant="ghost" size="sm" @click="emit('detail', item)">
                    <ScrollText class="mr-1 h-3.5 w-3.5" />
                    详情
                  </Button>
                  <Button
                    v-if="isAdmin"
                    variant="ghost"
                    size="icon"
                    title="删除"
                    class="text-red-600 hover:text-red-700"
                    @click="emit('single-delete', item)"
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
          @page-change="(p: number) => emit('page-change', p)"
        />
      </div>
    </CardContent>
  </Card>
</template>
