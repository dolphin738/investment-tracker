<script setup lang="ts">
/**
 * modules/admin/components/ScheduleTaskTable.vue — 定时任务列表表格（普通 / 系统两分类共用）
 *
 * 从 SchedulePage 抽出：普通任务与系统任务两个 Tab 的表格仅有三处差异 —— 数据源
 * （由父级传入的 tasks）、空态文案（emptyTitle / emptyDescription）、删除按钮是否渲染
 * （allowDelete）；均以 props 收口，一份模板复用。
 *
 * 空态判定沿用拆分前口径：父级以「全量任务」是否为空下传 empty（对齐页面原
 * `(tasks ?? []).length === 0`，而非按当前分类子集判定）。
 * 启用开关 / 立即执行按钮的禁用态分别由 updatePending / triggerPending 下传，
 * 保证「对话框保存中，表格开关同步禁用」的跨组件一致 pending 语义。
 * 展示格式化函数来自 utils/schedule-format（与执行日志弹窗共用）。
 */
import { Pencil, Play, ScrollText, Trash2 } from 'lucide-vue-next';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { describeCron } from '@/lib/cron';
import { formatDateTime } from '@/lib/utils';
import { TASK_KIND_LABEL, TASK_TYPE_LABEL } from '@/modules/admin/composables/use-schedule';
import {
  cronTitle,
  kindVariant,
  runVariant,
  statusLabel,
} from '@/modules/admin/utils/schedule-format';
import type { ScheduleTask } from '@/api/schedule.api';

defineProps<{
  /** 本表渲染的任务行（已由父级按分类过滤） */
  tasks: ScheduleTask[];
  /** 列表加载中：优先展示骨架屏 */
  loading: boolean;
  /** 全量任务为空（沿用拆分前 `(tasks ?? []).length === 0` 口径） */
  empty: boolean;
  /** 空态标题 */
  emptyTitle: string;
  /** 空态描述 */
  emptyDescription: string;
  /** 是否渲染删除按钮（普通任务 true / 系统任务 false） */
  allowDelete: boolean;
  /** 快速启停禁用态（门面下传的 update mutation pending） */
  updatePending: boolean;
  /** 立即执行禁用态（门面下传的 trigger mutation pending） */
  triggerPending: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle', task: ScheduleTask, enabled: boolean): void;
  (e: 'edit', task: ScheduleTask): void;
  (e: 'trigger', task: ScheduleTask): void;
  (e: 'logs', task: ScheduleTask): void;
  (e: 'remove', task: ScheduleTask): void;
}>();
</script>

<template>
  <Card>
    <CardContent>
      <TableSkeleton v-if="loading" :rows="6" :cols="7" class="py-2" />
      <EmptyState
        v-else-if="empty"
        :title="emptyTitle"
        :description="emptyDescription"
      />
      <Table v-else class="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead class="w-[180px] whitespace-nowrap">名称</TableHead>
            <TableHead class="w-[130px] whitespace-nowrap">类型</TableHead>
            <TableHead class="w-[100px] whitespace-nowrap">归类</TableHead>
            <TableHead class="w-16 whitespace-nowrap">启用</TableHead>
            <TableHead class="w-[160px]">cron</TableHead>
            <TableHead class="w-[180px] whitespace-nowrap">最近一次执行</TableHead>
            <TableHead class="w-[180px] whitespace-nowrap text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="task in tasks" :key="task.id">
            <TableCell class="truncate align-middle font-medium" :title="task.name">
              {{ task.name }}
            </TableCell>
            <TableCell class="truncate align-middle text-muted-foreground">
              {{ TASK_TYPE_LABEL[task.task_type] ?? task.task_type }}
            </TableCell>
            <TableCell class="align-middle">
              <Badge :variant="kindVariant(task.kind)">
                {{ TASK_KIND_LABEL[task.kind] ?? task.kind }}
              </Badge>
            </TableCell>
            <TableCell class="whitespace-nowrap align-middle">
              <Switch
                :model-value="task.enabled"
                :disabled="updatePending"
                @update:model-value="(v: boolean) => emit('toggle', task, v)"
              />
            </TableCell>
            <TableCell class="align-middle text-sm leading-snug" :title="cronTitle(task)">
              {{ describeCron(task.cron_expr) ?? task.cron_expr }}
            </TableCell>
            <TableCell class="whitespace-nowrap align-middle">
              <div class="flex flex-col gap-1">
                <span v-if="task.last_run_at" class="text-xs text-muted-foreground">
                  {{ formatDateTime(task.last_run_at) }}
                </span>
                <span v-else class="text-xs text-muted-foreground">从未执行</span>
                <Badge
                  v-if="task.last_run_status"
                  class="w-fit"
                  :variant="runVariant(task.last_run_status)"
                >
                  {{ statusLabel(task.last_run_status) }}
                </Badge>
              </div>
            </TableCell>
            <TableCell class="text-right align-middle">
              <div class="flex justify-end gap-1">
                <Button variant="ghost" size="sm" @click="emit('edit', task)">
                  <Pencil class="mr-1 h-3.5 w-3.5" />
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="triggerPending"
                  title="立即执行一次"
                  @click="emit('trigger', task)"
                >
                  <Play class="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="查看执行日志"
                  @click="emit('logs', task)"
                >
                  <ScrollText class="h-3.5 w-3.5" />
                </Button>
                <Button
                  v-if="allowDelete"
                  variant="ghost"
                  size="sm"
                  class="text-red-500 hover:text-red-600"
                  title="删除任务"
                  @click="emit('remove', task)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
