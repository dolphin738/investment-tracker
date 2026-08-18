<script setup lang="ts">
/**
 * modules/admin/components/InterfaceCategorySection.vue — 接口分类管理板块
 *
 * 平移自 React 版 features/admin/interface-category-section.tsx，行为契约一致。
 * 分类改版后为固定分类（分类即用途，证券列表/证券行情…），故不提供新增/删除入口，
 * 仅允许编辑展示名/图标/排序；系统内置分类以 badge 标注。
 */

import { Pencil } from 'lucide-vue-next';
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
import type { InterfaceCategory } from '@/api/interface-category.api';
import { useInterfaceCategories } from '../composables/use-interface-category';
import InterfaceCategoryDialog from './InterfaceCategoryDialog.vue';
import { ref } from 'vue';

const { data: categories, isLoading } = useInterfaceCategories();

const dialogOpen = ref(false);
const editing = ref<InterfaceCategory | null>(null);

function openEdit(cat: InterfaceCategory): void {
  editing.value = cat;
  dialogOpen.value = true;
}
function close(): void {
  dialogOpen.value = false;
  editing.value = null;
}
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-start justify-between gap-4">
        <div>
          <CardTitle class="text-base">接口分类管理</CardTitle>
          <CardDescription>
            分类即接口用途（如「证券列表」拉取证券主数据、「证券行情」拉取价格）；
            可调整展示名 / 图标 / 排序，不可新增或删除
          </CardDescription>
        </div>
      </div>
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
            <TableCell class="text-right">
              <div class="flex justify-end gap-1">
                <Button variant="ghost" size="sm" @click="openEdit(c)">
                  <Pencil class="mr-1 h-3.5 w-3.5" />
                  编辑
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
      @open-change="(v: boolean) => (v ? (dialogOpen = true) : close())"
    />
  </Card>
</template>