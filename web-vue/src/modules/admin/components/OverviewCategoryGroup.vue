<script setup lang="ts">
/**
 * modules/admin/components/OverviewCategoryGroup.vue — 单分类分组
 *
 * 平移自 React 版 features/admin/quote-provider-section.tsx 的 OverviewCategoryGroup +
 * SortableOverviewRow + OverviewInterfaceRow。
 * 已分类（categoryId 非空）→ VueDraggable 可拖拽调序（ADR-002 优先级链，容器为 tbody）；
 * 未分类（categoryId 为 null）→ 普通表格（不可拖拽）。
 */

import { ref, watch } from 'vue';
import { GripVertical } from 'lucide-vue-next';
import { VueDraggable } from 'vue-draggable-plus';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { QuoteInterface } from '@/api/quote-interface.api';
import type { QuoteProvider } from '@/api/quote-provider.api';
import { useReorderInterfaces } from '../composables/use-quote-interface';
import InterfaceEnabledSwitch from './InterfaceEnabledSwitch.vue';

const props = defineProps<{
  /** null = 未分类分组（不提供拖拽） */
  categoryId: string | null;
  label: string;
  items: QuoteInterface[];
  providerById: Map<string, QuoteProvider>;
}>();

const reorderMut = useReorderInterfaces();

// 本地可拖拽列表：query 数据变化时同步；拖拽时由 VueDraggable 自动重排
const localItems = ref<QuoteInterface[]>([...props.items]);
watch(
  () => props.items,
  (val) => {
    localItems.value = [...val];
  },
  { deep: true },
);

function providerName(it: QuoteInterface): string {
  return props.providerById.get(it.provider_id)?.name ?? it.provider_id;
}

function onDragEnd(): void {
  const next = localItems.value.map((i) => i.id);
  const before = props.items.map((i) => i.id);
  if (next.join() === before.join()) return;
  if (props.categoryId) {
    reorderMut.mutate({ category_id: props.categoryId, ordered_ids: next });
  }
}
</script>

<template>
  <div class="mb-5">
    <div class="mb-2 flex items-center gap-2">
      <span class="text-sm font-medium">{{ props.label }}</span>
      <Badge variant="outline">{{ props.items.length }}</Badge>
    </div>

    <!-- 已分类：可拖拽调序（VueDraggable 容器为 tbody，仅行可拖拽） -->
    <Table v-if="props.categoryId" class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-8" />
          <TableHead class="w-[200px] whitespace-nowrap">名称</TableHead>
          <TableHead class="w-[180px] whitespace-nowrap">提供方名称</TableHead>
          <TableHead class="w-[280px] whitespace-nowrap">调用路径</TableHead>
          <TableHead class="w-16 whitespace-nowrap">方法</TableHead>
          <TableHead class="w-20 whitespace-nowrap">启用</TableHead>
        </TableRow>
      </TableHeader>
      <VueDraggable
        tag="tbody"
        v-model="localItems"
        :animation="150"
        :handle="'.overview-drag-handle'"
        @end="onDragEnd"
      >
        <TableRow
          v-for="it in localItems"
          :key="it.id"
          class="transition-colors hover:bg-muted/50"
        >
          <TableCell class="w-8 align-middle">
            <button
              type="button"
              class="overview-drag-handle flex h-7 w-7 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
              :aria-label="`拖拽排序 ${it.name}`"
            >
              <GripVertical class="h-4 w-4" />
            </button>
          </TableCell>
          <TableCell class="truncate font-medium align-middle">{{ it.name }}</TableCell>
          <TableCell class="truncate align-middle text-muted-foreground">
            {{ providerName(it) }}
          </TableCell>
          <TableCell class="truncate align-middle text-muted-foreground">
            {{ it.endpoint ?? '-' }}
          </TableCell>
          <TableCell class="whitespace-nowrap align-middle">
            {{ it.http_method ?? '-' }}
          </TableCell>
          <TableCell class="whitespace-nowrap align-middle">
            <InterfaceEnabledSwitch
              :item="it"
              :provider-enabled="
                props.providerById.get(it.provider_id)?.enabled ?? false
              "
            />
          </TableCell>
        </TableRow>
      </VueDraggable>
    </Table>

    <!-- 未分类：普通表格（不可拖拽） -->
    <Table v-else class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-8" />
          <TableHead class="w-[200px] whitespace-nowrap">名称</TableHead>
          <TableHead class="w-[180px] whitespace-nowrap">提供方名称</TableHead>
          <TableHead class="w-[280px] whitespace-nowrap">调用路径</TableHead>
          <TableHead class="w-16 whitespace-nowrap">方法</TableHead>
          <TableHead class="w-20 whitespace-nowrap">启用</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="it in props.items" :key="it.id">
          <TableCell class="w-8" />
          <TableCell class="truncate font-medium align-middle">{{ it.name }}</TableCell>
          <TableCell class="truncate align-middle text-muted-foreground">
            {{ providerName(it) }}
          </TableCell>
          <TableCell class="truncate align-middle text-muted-foreground">
            {{ it.endpoint ?? '-' }}
          </TableCell>
          <TableCell class="whitespace-nowrap align-middle">
            {{ it.http_method ?? '-' }}
          </TableCell>
          <TableCell class="whitespace-nowrap align-middle">
            <InterfaceEnabledSwitch
              :item="it"
              :provider-enabled="
                props.providerById.get(it.provider_id)?.enabled ?? false
              "
            />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>