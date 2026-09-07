<script setup lang="ts">
/**
 * modules/admin/components/InterfaceCategorySection.vue — 接口分类管理板块
 *
 * 平移自 React 版 features/admin/interface-category-section.tsx，行为契约一致。
 * 支持新增分类、编辑展示名/图标/排序、删除分类；系统内置分类不提供删除入口，
 * 分类下已配置接口时删除按钮禁用（后端对两者亦有 400 保护）。
 */

import { Pencil, Trash2 } from 'lucide-vue-next';
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import DynamicIcon from '@/components/common/DynamicIcon.vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import type { InterfaceCategory } from '@/api/interface-category.api';
import {
  useDeleteInterfaceCategory,
  useInterfaceCategories,
} from '../composables/use-interface-category';
import InterfaceCategoryDialog from './InterfaceCategoryDialog.vue';

const { data: categories, isLoading } = useInterfaceCategories();
const deleteMut = useDeleteInterfaceCategory();

const dialogOpen = ref(false);
const editing = ref<InterfaceCategory | null>(null);
const deleteId = ref<string | null>(null);

/** 分类下是否已配置接口（据此禁用删除） */
function hasInterfaces(c: InterfaceCategory): boolean {
  return c.interface_count > 0;
}

function openCreate(): void {
  editing.value = null;
  dialogOpen.value = true;
}
function openEdit(cat: InterfaceCategory): void {
  editing.value = cat;
  dialogOpen.value = true;
}
function close(): void {
  dialogOpen.value = false;
  editing.value = null;
}
function handleDialogOpenChange(v: boolean): void {
  if (v) dialogOpen.value = true;
  else close();
}

function handleConfirmDelete(): void {
  if (deleteId.value) {
    deleteMut.mutate(deleteId.value, { onSuccess: () => (deleteId.value = null) });
  }
}

/**
 * 删除确认弹窗关闭处理。
 *
 * reka-ui AlertDialogAction（内部 DialogClose）的关闭 handler 与用户 @click 按
 * [reka, user] 顺序合并执行：reka 先 onOpenChange(false) 再跑用户 handler。
 * 同步清空 deleteId 会让确认 handler 读不到删除目标（对齐 QuoteProviderSection 模式）。
 */
function handleDeleteDialogOpenChange(open: boolean): void {
  if (!open) {
    queueMicrotask(() => (deleteId.value = null));
  }
}

/** 暴露给父页面（AdminPage），使其可在顶层 Tab 栏右侧放置「新增分类」按钮 */
defineExpose({ openCreate });
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">接口分类管理</CardTitle>
      <CardDescription>
        分类即接口用途（如「证券列表」拉取证券主数据、「证券行情」拉取价格）；
        可调整展示名/图标/排序，可新增分类；分类下已配置接口时不可删除
      </CardDescription>
    </CardHeader>
    <CardContent>
      <p v-if="isLoading" class="py-8 text-center text-sm text-muted-foreground">
        加载中…
      </p>
      <p
        v-else-if="categories && categories.length === 0"
        class="py-8 text-center text-sm text-muted-foreground"
      >
        暂无分类
      </p>
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>展示名</TableHead>
            <TableHead>图标</TableHead>
            <TableHead>排序</TableHead>
            <TableHead>接口数</TableHead>
            <TableHead class="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="c in categories ?? []" :key="c.id">
            <TableCell class="font-medium">
              <span class="inline-flex items-center gap-2">
                {{ c.label }}
                <span
                  v-if="c.system"
                  class="rounded border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground"
                >
                  系统内置
                </span>
              </span>
            </TableCell>
            <TableCell>
              <DynamicIcon :name="c.icon" icon-class="h-4 w-4" />
            </TableCell>
            <TableCell>{{ c.sort_order }}</TableCell>
            <TableCell>{{ c.interface_count ?? 0 }}</TableCell>
            <TableCell class="text-right">
              <div class="flex justify-end gap-1">
                <Button variant="ghost" size="sm" @click="openEdit(c)">
                  <Pencil class="mr-1 h-3.5 w-3.5" />
                  编辑
                </Button>
                <Button
                  v-if="!c.system"
                  variant="ghost"
                  size="sm"
                  class="text-red-500 hover:text-red-600"
                  :disabled="hasInterfaces(c)"
                  :title="
                    hasInterfaces(c)
                      ? `已配置 ${c.interface_count} 个接口，不可删除`
                      : undefined
                  "
                  @click="deleteId = c.id"
                >
                  <Trash2 class="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>

    <InterfaceCategoryDialog
      :open="dialogOpen"
      :editing="editing"
      @open-change="handleDialogOpenChange"
    />

    <!-- 分类删除二次确认 -->
    <AlertDialog
      :open="deleteId !== null"
      @update:open="handleDeleteDialogOpenChange"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该分类？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后不可恢复；仅未配置接口的分类可删除。
          </AlertDialogDescription>
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
