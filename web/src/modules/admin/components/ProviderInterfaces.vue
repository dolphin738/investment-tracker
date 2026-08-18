<script setup lang="ts">
/**
 * modules/admin/components/ProviderInterfaces.vue — 单个提供方下的接口子表（按 category_id 分组）
 *
 * 平移自 React 版 features/admin/quote-provider-section.tsx 的 ProviderInterfaces。
 */

import { computed, ref } from 'vue';
import { Plus, Pencil, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import type { QuoteInterface } from '@/api/quote-interface.api';
import { useInterfaceCategories } from '../composables/use-interface-category';
import {
  useCreateInterface,
  useDeleteInterface,
  useQuoteInterfaces,
} from '../composables/use-quote-interface';
import { useQuoteProviders } from '../composables/use-quote-provider';
import QuoteInterfaceDialog from './QuoteInterfaceDialog.vue';
import InterfaceEnabledSwitch from './InterfaceEnabledSwitch.vue';

const props = defineProps<{ providerId: string }>();

const { data: interfaces, isLoading } = useQuoteInterfaces(props.providerId);
const { data: categories } = useInterfaceCategories();
const { data: providers } = useQuoteProviders();

/** 分类 key → 展示名（无匹配显示 raw key） */
const labelMap = computed(() => {
  const m = new Map<string, string>();
  (categories.value ?? []).forEach((c) => m.set(c.id, c.label));
  return m;
});

/** 父级提供方是否启用（父级总闸） */
const providerEnabled = computed(
  () => providers.value?.find((p) => p.id === props.providerId)?.enabled ?? true,
);

const createMut = useCreateInterface(props.providerId);
const deleteMut = useDeleteInterface();

const dialogOpen = ref(false);
const editing = ref<QuoteInterface | null>(null);
const deleteId = ref<string | null>(null);

/** 接口列表按 category_id 分组（Map 保持插入序） */
const groups = computed(() => {
  const map = new Map<string | null, QuoteInterface[]>();
  (interfaces.value ?? []).forEach((it) => {
    const k = it.category_id;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  });
  return Array.from(map.entries());
});

function openCreate(): void {
  editing.value = null;
  dialogOpen.value = true;
}
function openEdit(it: QuoteInterface): void {
  editing.value = it;
  dialogOpen.value = true;
}
function close(): void {
  dialogOpen.value = false;
  editing.value = null;
}

function handleConfirmDelete(): void {
  if (deleteId.value) {
    deleteMut.mutate(deleteId.value, { onSuccess: () => (deleteId.value = null) });
  }
}

function groupLabel(type: string | null): string {
  return type ? (labelMap.value.get(type) ?? type) : '未分类';
}
</script>

<template>
  <Card>
    <CardHeader class="pb-3">
      <div class="flex items-center justify-between">
        <CardTitle class="text-sm">接口列表</CardTitle>
        <Button size="sm" @click="openCreate">
          <Plus class="mr-1 h-3.5 w-3.5" />
          新增接口
        </Button>
      </div>
    </CardHeader>
    <CardContent>
      <p v-if="isLoading" class="py-4 text-center text-sm text-muted-foreground">
        加载中…
      </p>
      <p
        v-else-if="!isLoading && groups.length === 0"
        class="py-4 text-center text-sm text-muted-foreground"
      >
        该提供方暂无接口
      </p>
      <div v-else class="space-y-4">
        <div v-for="[type, items] in groups" :key="type ?? 'uncategorized'" class="mb-4">
          <div class="mb-1 text-xs font-medium text-muted-foreground">
            {{ groupLabel(type) }}
          </div>
          <Table class="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead class="w-[200px] whitespace-nowrap">名称</TableHead>
                <TableHead class="w-[280px] whitespace-nowrap">调用路径</TableHead>
                <TableHead class="w-16 whitespace-nowrap">方法</TableHead>
                <TableHead class="w-20 whitespace-nowrap">启用</TableHead>
                <TableHead class="w-[140px] text-right whitespace-nowrap">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="it in items" :key="it.id">
                <TableCell class="truncate font-medium align-middle">
                  {{ it.name }}
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
                    :provider-enabled="providerEnabled"
                  />
                </TableCell>
                <TableCell class="text-right align-middle">
                  <div class="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" @click="openEdit(it)">
                      <Pencil class="mr-1 h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="text-red-500 hover:text-red-600"
                      @click="deleteId = it.id"
                    >
                      <Trash2 class="mr-1 h-3.5 w-3.5" />
                      删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </CardContent>

    <QuoteInterfaceDialog
      :open="dialogOpen"
      :provider-id="props.providerId"
      :editing="editing"
      @open-change="(v: boolean) => (v ? (dialogOpen = true) : close())"
    />

    <AlertDialog
      :open="deleteId !== null"
      @update:open="(v: boolean) => !v && (deleteId = null)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该接口？</AlertDialogTitle>
          <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            class="bg-red-500 hover:bg-red-600"
            @click="handleConfirmDelete"
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>
</template>