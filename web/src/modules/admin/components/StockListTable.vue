<script setup lang="ts">
/**
 * modules/admin/components/StockListTable.vue — 表格区域（平移自 StockListPanel.vue）
 *
 * 渲染 loading / error / empty 三态与 <Table>；数据由门面 StockListPanel 以 props 传入。
 * useSecurityMasters 等数据拉取保留在门面，本组件不发起任何请求（避免挂载死锁）。
 *
 * 仅承载表格所需的纯展示逻辑（表头三态、行勾选 ref、代码大写展示），
 * 选择状态与删除确认仍由门面持有：本组件通过 emit 把交互回传门面既有处理函数。
 */

import { computed, type ComponentPublicInstance } from 'vue';
import { ArrowRight, Loader2, Trash2 } from 'lucide-vue-next';
import { securityTypeLabel } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SecurityMaster } from '@/api/security-master.api';

const props = defineProps<{
  items: SecurityMaster[];
  isLoading: boolean;
  isError: boolean;
  selectAll: boolean;
  selectedIds: Set<string>;
  isAdmin: boolean;
}>();
const emit = defineEmits<{
  /** 把某行 code 填入右侧接口测试 */
  pickCode: [code: string];
  /** 单行删除（交由门面维护 confirmPayload） */
  singleDelete: [s: SecurityMaster];
  /** 表头全选（合并模式），checked 直传门面 handleHeaderSelect */
  headerSelect: [checked: boolean];
  /** 单行勾选，直传门面 handleRowSelect */
  rowSelect: [s: SecurityMaster, checked: boolean];
}>();

// 当前页已选行数（用于表头 checkbox 三态：全选 / 半选 / 未选）
const pageSelectedCount = computed(
  () => props.items.filter((s) => props.selectedIds.has(s.id)).length,
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

/** 交易所字母大写：仅把代码开头的字母前缀转为大写，数字与后缀不动。
 * 仅作用于展示；填入右侧测试仍使用原始 code。 */
function formatExchangeCode(code: string): string {
  const m = code.match(/^[a-zA-Z]+/);
  if (!m) return code;
  return code.slice(0, m[0].length).toUpperCase() + code.slice(m[0].length);
}
</script>

<template>
  <div
    v-if="isLoading"
    class="flex items-center gap-2 py-8 text-sm text-muted-foreground"
  >
    <Loader2 class="h-4 w-4 animate-spin" /> 加载中…
  </div>
  <p v-else-if="isError" class="py-8 text-center text-sm text-red-500">
    加载失败，请刷新重试
  </p>
  <p
    v-else-if="!isLoading && !isError && items.length === 0"
    class="py-8 text-center text-sm text-muted-foreground"
  >
    暂无主数据，点击右上角「同步」拉取
  </p>

  <Table v-if="!isLoading && !isError && items.length > 0">
    <TableHeader>
      <TableRow>
        <TableHead class="w-12">
          <input
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
            :checked="selectAll || allPageSelected"
            :ref="setHeaderIndeterminate"
            @change="
              ($event) =>
                emit('headerSelect', ($event.target as HTMLInputElement).checked)
            "
          />
        </TableHead>
        <TableHead class="w-12">#</TableHead>
        <TableHead class="w-28">代码</TableHead>
        <TableHead>名称</TableHead>
        <TableHead class="w-20">类别</TableHead>
        <TableHead class="w-16 text-right">操作</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow
        v-for="(s, index) in items"
        :key="s.id"
        :class="selectAll || selectedIds.has(s.id) ? 'bg-muted/40' : ''"
      >
        <TableCell>
          <input
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
            :checked="selectAll || selectedIds.has(s.id)"
            :disabled="selectAll"
            :ref="noopRef"
            @change="
              ($event) =>
                emit('rowSelect', s, ($event.target as HTMLInputElement).checked)
            "
          />
        </TableCell>
        <TableCell class="text-muted-foreground">{{ index + 1 }}</TableCell>
        <TableCell class="font-mono">{{ formatExchangeCode(s.code) }}</TableCell>
        <TableCell class="truncate">{{ s.name }}</TableCell>
        <TableCell>{{ securityTypeLabel(s.assetClass) }}</TableCell>
        <TableCell class="text-right">
          <div class="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              title="填入右侧测试"
              @click="emit('pickCode', s.code)"
            >
              <ArrowRight class="h-3.5 w-3.5" />
            </Button>
            <Button
              v-if="isAdmin"
              variant="ghost"
              size="icon"
              title="删除"
              class="text-red-600 hover:text-red-700"
              @click="emit('singleDelete', s)"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
