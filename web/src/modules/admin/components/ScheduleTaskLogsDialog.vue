<script setup lang="ts">
/**
 * modules/admin/components/ScheduleTaskLogsDialog.vue — 执行日志弹窗（服务端分页）
 *
 * 从 SchedulePage 抽出：日志查询 useTaskLogs 与本弹窗的 taskId / 页码状态就地持有
 * （只读查询，无跨组件单例约束）；由父级经模板 ref 调用 openLogs(taskId) 打开。
 * 标题所需任务名从父级下传的 tasks 列表实时解析（保持拆分前随列表刷新的行为）。
 */
import { computed, ref } from 'vue';
import { formatDateTime } from '@/lib/utils';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  TRIGGER_SOURCE_LABEL,
  useTaskLogs,
} from '@/modules/admin/composables/use-schedule';
import { runVariant, statusLabel } from '@/modules/admin/utils/schedule-format';
import type { ScheduleTask, TaskLogQuery } from '@/api/schedule.api';

const props = defineProps<{
  /** 全量任务列表（用于解析当前日志所属任务的标题） */
  tasks: ScheduleTask[];
}>();

const LOG_PAGE_SIZE = 20;
const logsTaskId = ref<string | null>(null);
const logPage = ref(1);

const logsQuery = useTaskLogs(
  computed<string | null>(() => logsTaskId.value),
  computed<TaskLogQuery>(() => ({ page: logPage.value, pageSize: LOG_PAGE_SIZE })),
);
const logs = computed(() => logsQuery.data.value);
const logsLoading = computed(() => logsQuery.isLoading.value);
const logsTotal = computed(() => logs.value?.total ?? 0);
const logsTotalPages = computed(() => Math.max(1, Math.ceil(logsTotal.value / LOG_PAGE_SIZE)));
/** 当前日志所属任务（用于标题） */
const logsTask = computed(() =>
  props.tasks.find((t) => t.id === logsTaskId.value) ?? null,
);

/** 打开日志弹窗（供父级经模板 ref 调用） */
function openLogs(taskId: string): void {
  logsTaskId.value = taskId;
  logPage.value = 1;
}
function closeLogs(): void {
  logsTaskId.value = null;
}

defineExpose({ openLogs });
</script>

<template>
  <Dialog :open="logsTaskId !== null" @update:open="(v: boolean) => !v && closeLogs()">
    <DialogContent class="max-w-3xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>执行日志 · {{ logsTask?.name ?? '' }}</DialogTitle>
        <DialogDescription>
          分页展示该任务最近 {{ LOG_PAGE_SIZE }} 条执行记录
        </DialogDescription>
      </DialogHeader>

      <TableSkeleton v-if="logsLoading" :rows="4" :cols="4" class="py-2" />
      <EmptyState
        v-else-if="(logs?.items ?? []).length === 0"
        title="暂无执行记录"
        description="任务尚未被调度执行，可先在上方手动触发一次"
        class="py-10"
      />
      <div v-else>
        <Table class="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead class="w-[170px] whitespace-nowrap">开始时间</TableHead>
              <TableHead class="w-[170px] whitespace-nowrap">结束时间</TableHead>
              <TableHead class="w-[90px] whitespace-nowrap">触发来源</TableHead>
              <TableHead class="w-16 whitespace-nowrap">状态</TableHead>
              <TableHead>结果 / 错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="log in logs?.items ?? []" :key="log.id">
              <TableCell class="whitespace-nowrap align-middle text-xs">
                {{ formatDateTime(log.started_at) }}
              </TableCell>
              <TableCell class="whitespace-nowrap align-middle text-xs">
                {{ formatDateTime(log.finished_at) }}
              </TableCell>
              <TableCell class="whitespace-nowrap align-middle text-xs">
                {{ TRIGGER_SOURCE_LABEL[log.trigger_source] ?? log.trigger_source }}
              </TableCell>
              <TableCell class="align-middle">
                <Badge v-if="log.status" :variant="runVariant(log.status)">
                  {{ statusLabel(log.status) }}
                </Badge>
              </TableCell>
              <TableCell class="truncate align-middle text-xs" :title="log.error ?? log.message ?? ''">
                {{ log.error ?? log.message ?? '-' }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div
        v-if="!logsLoading && logsTotal > 0"
        class="flex items-center justify-between pt-2"
      >
        <span class="text-xs text-muted-foreground">
          共 {{ logsTotal }} 条 · 第 {{ logPage }}/{{ logsTotalPages }} 页
        </span>
        <div class="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            :disabled="logPage <= 1"
            @click="logPage = Math.max(1, logPage - 1)"
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="logPage >= logsTotalPages"
            @click="logPage = Math.min(logsTotalPages, logPage + 1)"
          >
            下一页
          </Button>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="closeLogs">关闭</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
