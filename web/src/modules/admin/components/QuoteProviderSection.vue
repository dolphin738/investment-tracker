<script setup lang="ts">
/**
 * modules/admin/components/QuoteProviderSection.vue — 数据来源（提供方）管理板块
 *
 * 平移自 React 版 features/admin/quote-provider-section.tsx，行为契约一致。
 * - 提供方按接入方式分组（HTTPS 提供方 / SDK 提供方）。
 * - 每个提供方行：停用/启用 / 编辑 / 删除（沿用现有 composable）。
 * - 每个提供方展开区：接口子表 ProviderInterfaces + 新增/编辑/删除接口。
 * - 顶层「按分类汇总所有提供方接口」总览 InterfacesByCategoryOverview。
 */

import { computed, ref } from 'vue';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  CardDescription,
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
import type { QuoteProvider } from '@/api/quote-provider.api';
import {
  useDeleteQuoteProvider,
  useQuoteProviders,
  useUpdateQuoteProvider,
} from '../composables/use-quote-provider';
import ProviderInterfaces from './ProviderInterfaces.vue';
import InterfacesByCategoryOverview from './InterfacesByCategoryOverview.vue';
import QuoteProviderDialog from './QuoteProviderDialog.vue';

const { data: providers, isLoading, isError } = useQuoteProviders();
const deleteMut = useDeleteQuoteProvider();
const updateMut = useUpdateQuoteProvider();

const dialogOpen = ref(false);
const editing = ref<QuoteProvider | null>(null);
const deleteId = ref<string | null>(null);
/** 展开行集合：providerId → 是否展开 */
const expanded = ref<Record<string, boolean>>({});

const httpsProviders = computed(() =>
  (providers.value ?? []).filter((p) => p.access_method === 'https'),
);
const sdkProviders = computed(() =>
  (providers.value ?? []).filter((p) => p.access_method === 'sdk'),
);

function openCreate(): void {
  editing.value = null;
  dialogOpen.value = true;
}
function openEdit(p: QuoteProvider): void {
  editing.value = p;
  dialogOpen.value = true;
}
function handleDialogOpenChange(v: boolean): void {
  if (v) dialogOpen.value = true;
  else {
    dialogOpen.value = false;
    editing.value = null;
  }
}
const toggleExpand = (id: string): void => {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
};

function toggleEnabled(p: QuoteProvider): void {
  if (!updateMut.isPending.value) {
    updateMut.mutate({ id: p.id, body: { enabled: !p.enabled } });
  }
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
 * 同步清空 deleteId 会让确认 handler 读不到删除目标（对齐 PortfolioManagementCard 模式）。
 */
function handleDeleteDialogOpenChange(open: boolean): void {
  if (!open) {
    queueMicrotask(() => (deleteId.value = null));
  }
}

/** 暴露给父页面（AdminPage），使其可在顶层 Tab 栏右侧放置「新增数据来源」按钮 */
defineExpose({ openCreate });
</script>

<template>
  <div class="space-y-6">
    <Card>
      <CardHeader>
        <div>
          <CardTitle class="text-base">数据来源</CardTitle>
          <CardDescription>
            配置多个行情数据来源；运行时按接口分类级优先级链自动选源（详见 ADR-002）
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div
          v-if="isLoading"
          class="flex items-center gap-2 py-8 text-sm text-muted-foreground"
        >
          <Loader2 class="h-4 w-4 animate-spin" />
          加载中…
        </div>
        <p v-else-if="isError" class="py-8 text-center text-sm text-red-500">
          加载失败，请刷新重试
        </p>
        <p
          v-else-if="providers && providers.length === 0"
          class="py-8 text-center text-sm text-muted-foreground"
        >
          暂无数据来源，点击右上角「新增数据来源」开始配置
        </p>
        <div v-else class="space-y-6">
          <div v-if="httpsProviders.length > 0">
            <h4 class="mb-2 text-sm font-medium text-muted-foreground">
              HTTPS 提供方
            </h4>
            <Table class="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10" />
                  <TableHead class="w-[200px]">名称</TableHead>
                  <TableHead class="w-24">接入方式</TableHead>
                  <TableHead class="w-[240px]">连接信息</TableHead>
                  <TableHead class="w-24">状态</TableHead>
                  <TableHead class="w-[260px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="p in httpsProviders" :key="p.id">
                  <TableRow class="cursor-pointer" @click="toggleExpand(p.id)">
                    <TableCell>
                      <span
                        class="inline-flex h-8 w-8 items-center justify-center text-muted-foreground"
                      >
                        <ChevronDown v-if="expanded[p.id]" class="h-4 w-4" />
                        <ChevronRight v-else class="h-4 w-4" />
                      </span>
                    </TableCell>
                    <TableCell class="truncate font-medium">{{ p.name }}</TableCell>
                    <TableCell>HTTPS</TableCell>
                    <TableCell class="truncate text-muted-foreground">
                      {{ (p.config?.base_url as string) ?? '-' }}
                    </TableCell>
                    <TableCell>
                      <div class="flex flex-wrap gap-1">
                        <Badge v-if="!p.enabled" variant="secondary">停用</Badge>
                      </div>
                    </TableCell>
                    <TableCell class="text-right" @click.stop>
                      <div class="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          :disabled="updateMut.isPending.value"
                          :title="p.enabled ? '停用该数据来源' : '启用该数据来源'"
                          @click="toggleEnabled(p)"
                        >
                          <PowerOff v-if="p.enabled" class="mr-1 h-3.5 w-3.5" />
                          <Power v-else class="mr-1 h-3.5 w-3.5" />
                          {{ p.enabled ? '停用' : '启用' }}
                        </Button>
                        <Button variant="ghost" size="sm" @click="openEdit(p)">
                          <Pencil class="mr-1 h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-red-500 hover:text-red-600"
                          @click="deleteId = p.id"
                        >
                          <Trash2 class="mr-1 h-3.5 w-3.5" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="expanded[p.id]">
                    <TableCell colspan="6" class="bg-muted/40 p-3">
                      <ProviderInterfaces :provider-id="p.id" />
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </Table>
          </div>

          <div v-if="sdkProviders.length > 0">
            <h4 class="mb-2 text-sm font-medium text-muted-foreground">
              SDK 提供方
            </h4>
            <Table class="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10" />
                  <TableHead class="w-[200px]">名称</TableHead>
                  <TableHead class="w-24">接入方式</TableHead>
                  <TableHead class="w-[240px]">连接信息</TableHead>
                  <TableHead class="w-24">状态</TableHead>
                  <TableHead class="w-[260px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="p in sdkProviders" :key="p.id">
                  <TableRow class="cursor-pointer" @click="toggleExpand(p.id)">
                    <TableCell>
                      <span
                        class="inline-flex h-8 w-8 items-center justify-center text-muted-foreground"
                      >
                        <ChevronDown v-if="expanded[p.id]" class="h-4 w-4" />
                        <ChevronRight v-else class="h-4 w-4" />
                      </span>
                    </TableCell>
                    <TableCell class="truncate font-medium">{{ p.name }}</TableCell>
                    <TableCell>SDK</TableCell>
                    <TableCell class="truncate text-muted-foreground">
                      {{ (p.config?.sdk_name as string) ?? '-' }}
                    </TableCell>
                    <TableCell>
                      <div class="flex flex-wrap gap-1">
                        <Badge v-if="!p.enabled" variant="secondary">停用</Badge>
                      </div>
                    </TableCell>
                    <TableCell class="text-right" @click.stop>
                      <div class="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          :disabled="updateMut.isPending.value"
                          :title="p.enabled ? '停用该数据来源' : '启用该数据来源'"
                          @click="toggleEnabled(p)"
                        >
                          <PowerOff v-if="p.enabled" class="mr-1 h-3.5 w-3.5" />
                          <Power v-else class="mr-1 h-3.5 w-3.5" />
                          {{ p.enabled ? '停用' : '启用' }}
                        </Button>
                        <Button variant="ghost" size="sm" @click="openEdit(p)">
                          <Pencil class="mr-1 h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-red-500 hover:text-red-600"
                          @click="deleteId = p.id"
                        >
                          <Trash2 class="mr-1 h-3.5 w-3.5" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  <TableRow v-if="expanded[p.id]">
                    <TableCell colspan="6" class="bg-muted/40 p-3">
                      <ProviderInterfaces :provider-id="p.id" />
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>

    <InterfacesByCategoryOverview />

    <!-- 提供方新增 / 编辑对话框 -->
    <QuoteProviderDialog
      :open="dialogOpen"
      :editing="editing"
      @open-change="handleDialogOpenChange"
    />

    <!-- 提供方删除二次确认 -->
    <AlertDialog
      :open="deleteId !== null"
      @update:open="handleDeleteDialogOpenChange"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该数据来源？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后不可恢复；其下接口将一并删除。
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
  </div>
</template>