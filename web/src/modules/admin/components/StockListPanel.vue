<script setup lang="ts">
/**
 * modules/admin/components/StockListPanel.vue — 左栏：系统级证券主数据（门面）
 *
 * 平移自 React 版 features/admin/stock-list-test-section.tsx 的 StockListPanel，行为契约一致。
 * 只读浏览（由接口同步）、关键字搜索（防抖 300ms）、分页、类别/交易所筛选、
 * 批量/单行删除（仅管理员，被组合持仓引用的跳过）。
 *
 * 拆分说明：表格区域（loading / error / empty / Table）已下放到 StockListTable.vue。
 * useSecurityMasters 等数据拉取仍保留在本门面，items 以 props 下传，
 * 避免「子组件挂载依赖数据 → 数据请求永不触发」的死锁。
 */

import { computed, onBeforeUnmount, ref } from 'vue';
import { RefreshCw, Trash2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import { cn } from '@/lib/utils';
import { EXCHANGE_LABELS, SECURITY_TYPE_LABELS } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import Pagination from '@/components/common/Pagination.vue';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { useIsAdmin } from '@/stores/auth.store';
import {
  useDeleteSecurityMasters,
  useSecurityMasters,
} from '../composables/use-security-master';
import type {
  SecurityMaster,
  SecurityMasterDeleteParams,
} from '@/api/security-master.api';
import StockListTable from './StockListTable.vue';

const PAGE_SIZE = 20;

const props = defineProps<{
  /** 同步进行中（禁用同步/删除交互态的上游来源） */
  syncPending: boolean;
}>();
const emit = defineEmits<{
  /** 触发主数据同步（由容器持有 mutation 并共享「本次同步来源」） */
  sync: [];
  /** 把某行 code 填入右侧接口测试 */
  pickCode: [code: string];
}>();

const isAdmin = useIsAdmin();

// —— 删除（批量/单行）：仅管理员可用；删除权限与同步一致（require_admin） ——
const deleteMut = useDeleteSecurityMasters();
const selectedIds = ref<Set<string>>(new Set());
const confirmOpen = ref(false);
const confirmPayload = ref<SecurityMasterDeleteParams | null>(null);
const selectAll = ref(false);
/** 跨页选择：记录哪些页存在已选行（用于「已选 X 条（跨 Y 页）」提示与合并模式） */
const selectedPages = ref<Set<number>>(new Set());

// —— 列表状态：分页 + 搜索 + 筛选 ——
const page = ref(1);
const rawQ = ref('');
const q = ref('');
const assetClass = ref<string | null>(null);
const exchange = ref<string | null>(null);

// 搜索防抖 300ms (search 通用，见 React 版 rawQ → q)
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function onRawQChange(v: string): void {
  rawQ.value = v;
  if (debounceTimer) clearTimeout(debounceTimer);
  // 清空时立即生效，避免残影
  const next = v.trim();
  if (next === '') {
    q.value = '';
    resetToFirstPage();
    return;
  }
  debounceTimer = setTimeout(() => {
    q.value = next;
    resetToFirstPage();
  }, 300);
}

function resetToFirstPage(): void {
  page.value = 1;
  resetSelection();
}
function handleFilterChange(): void {
  resetToFirstPage();
}
function resetSelection(): void {
  selectedIds.value = new Set();
  selectAll.value = false;
  selectedPages.value = new Set();
}
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

const query = computed(() => ({
  page: page.value,
  pageSize: PAGE_SIZE,
  q: q.value,
  assetClass: assetClass.value ?? undefined,
  exchange: exchange.value ?? undefined,
}));
const { data, isLoading, isError } = useSecurityMasters(query);

const items = computed<SecurityMaster[]>(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

function openBatchDelete(): void {
  if (selectAll.value) {
    confirmPayload.value = {
      all: true,
      q: q.value,
      assetClass: assetClass.value ?? undefined,
      exchange: exchange.value ?? undefined,
    };
  } else if (selectedIds.value.size > 0) {
    confirmPayload.value = { ids: Array.from(selectedIds.value) };
  } else {
    return;
  }
  confirmOpen.value = true;
}
function openSingleDelete(s: SecurityMaster): void {
  confirmPayload.value = { ids: [s.id] };
  confirmOpen.value = true;
}
function handleConfirmDelete(): void {
  if (!confirmPayload.value) return;
  deleteMut.mutate(confirmPayload.value, {
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 条`);
      if (data.skipped.length > 0) {
        toast.warning(`${data.skipped.length} 条被引用或不存在，已跳过`);
      }
      resetSelection();
      confirmOpen.value = false;
    },
    onError: () => {
      confirmOpen.value = false;
    },
  });
}

/** 表头全选（合并模式）：仅在当前页范围内增删，不影响其它页已选 */
function handleHeaderSelect(v: boolean): void {
  if (selectAll.value) {
    selectAll.value = false;
    return;
  }
  const n = new Set(selectedIds.value);
  if (v) items.value.forEach((s) => n.add(s.id));
  else items.value.forEach((s) => n.delete(s.id));
  selectedIds.value = n;
  const pn = new Set(selectedPages.value);
  if (v) pn.add(page.value);
  else pn.delete(page.value);
  selectedPages.value = pn;
}

/** 单行勾选：登记所属页；取消时仅当本页无其它已选才移除页面标记 */
function handleRowSelect(s: SecurityMaster, v: boolean): void {
  const n = new Set(selectedIds.value);
  if (v) n.add(s.id);
  else n.delete(s.id);
  selectedIds.value = n;
  const pn = new Set(selectedPages.value);
  if (v) {
    pn.add(page.value);
  } else {
    const stillOnPage = items.value.some((it) => it.id !== s.id && n.has(it.id));
    if (!stillOnPage) pn.delete(page.value);
  }
  selectedPages.value = pn;
}
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-start justify-between gap-4">
        <div>
          <CardTitle class="text-base">证券主数据</CardTitle>
          <CardDescription>
            系统级全市场证券字典（由已配置接口定时同步；此处仅只读浏览）
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="default"
          :disabled="!isAdmin || syncPending"
          data-testid="sync-masters"
          @click="emit('sync')"
        >
          <RefreshCw :class="cn('mr-1 h-3.5 w-3.5', syncPending && 'animate-spin')" />
          同步
        </Button>
      </div>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-[200px] flex-1">
          <SearchInput
            :model-value="rawQ"
            placeholder="搜索代码 / 名称 / 拼音首字母"
            @update:model-value="onRawQChange"
            @clear="onRawQChange('')"
          />
        </div>
        <Select
          :model-value="assetClass ?? '__all__'"
          @update:model-value="
            ($event: string) => {
              assetClass = $event === '__all__' ? null : $event;
              handleFilterChange();
            }
          "
        >
          <SelectTrigger class="w-36 shrink-0">
            <SelectValue placeholder="全部类别" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部类别</SelectItem>
            <SelectItem
              v-for="[value, label] in Object.entries(SECURITY_TYPE_LABELS)"
              :key="value"
              :value="value"
            >
              {{ label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          :model-value="exchange ?? '__all__'"
          @update:model-value="
            ($event: string) => {
              exchange = $event === '__all__' ? null : $event;
              handleFilterChange();
            }
          "
        >
          <SelectTrigger class="w-28 shrink-0">
            <SelectValue placeholder="全部市场" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部市场</SelectItem>
            <SelectItem
              v-for="[value, label] in Object.entries(EXCHANGE_LABELS)"
              :key="value"
              :value="value"
            >
              {{ label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          v-if="isAdmin"
          variant="outline"
          size="sm"
          :disabled="!selectAll && selectedIds.size === 0"
          data-testid="batch-delete"
          class="shrink-0 text-red-600 hover:text-red-700"
          @click="openBatchDelete"
        >
          <Trash2 class="mr-1 h-3.5 w-3.5" />
          删除({{ selectAll ? total : selectedIds.size }})
        </Button>
        <Button
          v-if="isAdmin && !selectAll"
          variant="link"
          size="sm"
          data-testid="select-all-pages"
          class="shrink-0 px-0 text-muted-foreground"
          @click="selectAll = true"
        >
          全选全部 {{ total }} 条（跨页）
        </Button>
        <span
          v-if="!selectAll && selectedIds.size > 0"
          data-testid="selection-summary"
          class="shrink-0 text-xs text-muted-foreground"
        >
          已选 {{ selectedIds.size }} 条
          <template v-if="selectedPages.size > 1">（跨 {{ selectedPages.size }} 页）</template>
        </span>
      </div>

      <div
        v-if="selectAll"
        class="flex items-center justify-between rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm"
      >
        <span>已全选全部 {{ total }} 条主数据（跨所有页）</span>
        <Button
          variant="link"
          size="sm"
          data-testid="clear-select-all"
          class="px-0"
          @click="selectAll = false"
        >
          取消全选
        </Button>
      </div>

      <StockListTable
        :items="items"
        :is-loading="isLoading"
        :is-error="isError"
        :select-all="selectAll"
        :selected-ids="selectedIds"
        :is-admin="isAdmin"
        @pick-code="emit('pickCode', $event)"
        @single-delete="openSingleDelete"
        @header-select="handleHeaderSelect"
        @row-select="handleRowSelect"
      />

      <!-- 删除确认弹窗（批量/单行共用） -->
      <AlertDialog :open="confirmOpen" @update:open="confirmOpen = !!$event">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除证券主数据</AlertDialogTitle>
            <AlertDialogDescription>
              <template v-if="confirmPayload?.all">
                将删除全部 {{ total }} 条证券主数据（跨所有页，应用当前筛选条件）；其中被组合持仓引用的会被跳过。
              </template>
              <template v-else>
                将删除 {{ confirmPayload?.ids?.length ?? 0 }} 条证券主数据；其中被组合持仓引用的会被跳过。
              </template>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel :disabled="deleteMut.isPending.value">取消</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete"
              class="bg-red-600 hover:bg-red-700"
              :disabled="deleteMut.isPending.value"
              @click="handleConfirmDelete"
            >
              {{ deleteMut.isPending.value ? '删除中…' : '删除' }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <!-- 分页器 -->
      <Pagination
        :page="page"
        :total-pages="totalPages"
        :total="total"
        show-first-last
        show-jumper
        @page-change="(p: number) => (page = p)"
      />
    </CardContent>
  </Card>
</template>
