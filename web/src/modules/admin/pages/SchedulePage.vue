<script setup lang="ts">
/**
 * modules/admin/pages/SchedulePage.vue — 定时任务管理页（门面）
 *
 * 路由：/admin/tasks（name: admin-tasks，菜单「系统管理 → 定时任务」）。
 *
 * 行为契约：
 * - 系统任务（kind=SYSTEM）仅可编辑（类型/归类只读、可改 cron/启停/参数/名称/描述），不可删除；
 * - 普通任务（kind=NORMAL）可增删改。
 * - 新建任务类型来自 useTaskHandlers 的 creatable 清单（系统任务不在可建列表）。
 * - 立即执行（useTriggerTask）、快速启停（useUpdateTask.enabled）。
 * - 执行日志以 Dialog 抽屉展示，分页（useTaskLogs）。
 *
 * 鉴权：composable 内部已用 useIsAdmin 控制发起，页面仅对非管理员给出无权限提示。
 *
 * 拆分结构（本文件为门面，纯位置性拆分，除 EmptyState import 修复外零行为变更）：
 * - utils/schedule-format          展示格式化（kindVariant / runVariant / statusLabel / cronTitle）
 * - composables/use-schedule-form  新建/编辑表单状态机
 * - components/ScheduleTaskTable   任务表格（普通/系统两 Tab 合并）
 * - components/ScheduleTaskFormDialog / ScheduleTaskDeleteDialog / ScheduleTaskLogsDialog
 *
 * mutation 单例（create/update/delete/trigger）全部留在本门面：updateMut.isPending 同时
 * 驱动表格启用开关与对话框保存按钮，故必须共享同一实例，经 props 下传两个子组件。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/common/PageHeader.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ListTodo, Plus, Settings2 } from 'lucide-vue-next';
import ScheduleTaskTable from '@/modules/admin/components/ScheduleTaskTable.vue';
import ScheduleTaskFormDialog from '@/modules/admin/components/ScheduleTaskFormDialog.vue';
import ScheduleTaskDeleteDialog from '@/modules/admin/components/ScheduleTaskDeleteDialog.vue';
import ScheduleTaskLogsDialog from '@/modules/admin/components/ScheduleTaskLogsDialog.vue';
import { useScheduleForm } from '@/modules/admin/composables/use-schedule-form';
import {
  useCreateTask,
  useDeleteTask,
  useTaskHandlers,
  useTasks,
  useTriggerTask,
  useUpdateTask,
} from '@/modules/admin/composables/use-schedule';
import { usePersistentTab } from '@/composables/use-persistent-tab';
import { useIsAdmin } from '@/stores/auth.store';
import type { ScheduleTask } from '@/api/schedule.api';

const isAdmin = useIsAdmin();

const { data: tasks, isLoading } = useTasks();
const { data: handlers } = useTaskHandlers();

/** 列表分类分页：普通任务（NORMAL）在前、系统任务（SYSTEM）在后 */
const normalTasks = computed(() => (tasks.value ?? []).filter((t) => t.kind === 'NORMAL'));
const systemTasks = computed(() => (tasks.value ?? []).filter((t) => t.kind === 'SYSTEM'));
/** 列表分页当前页签：持久化 localStorage，刷新后仍停留当前分类（仿金融数据接口页） */
const listTab = usePersistentTab('invest:schedule-list-tab', 'normal', ['normal', 'system'] as const);
const createMut = useCreateTask();
const updateMut = useUpdateTask();
const deleteMut = useDeleteTask();
const triggerMut = useTriggerTask();

const {
  dialogOpen,
  editing,
  editTab,
  form,
  creatableHandlers,
  paramFields,
  hasLeveledParams,
  openCreate,
  openEdit,
  close,
  onTaskTypeChange,
  formPending,
  handleSubmit,
} = useScheduleForm(handlers, { createMut, updateMut });

// ---------------------------------------------------------------------------
// 子组件句柄：删除 / 日志弹窗自带状态，经模板 ref 触发
// ---------------------------------------------------------------------------
const deleteDialogRef = ref<InstanceType<typeof ScheduleTaskDeleteDialog> | null>(null);
const logsDialogRef = ref<InstanceType<typeof ScheduleTaskLogsDialog> | null>(null);

// ---------------------------------------------------------------------------
// 快速启停 / 立即执行
// ---------------------------------------------------------------------------
function handleToggleEnabled(task: ScheduleTask, v: boolean): void {
  if (task.enabled === v) return;
  updateMut.mutate({ id: task.id, body: { enabled: v } });
}

function handleTrigger(task: ScheduleTask): void {
  triggerMut.mutate(task.id);
}

function handleRemove(task: ScheduleTask): void {
  deleteDialogRef.value?.openConfirm(task.id);
}

function handleLogs(task: ScheduleTask): void {
  logsDialogRef.value?.openLogs(task.id);
}

/** 删除确认：执行 deleteMut（onSuccess 关闭确认弹窗，对齐拆分前清空 deleteId） */
function handleConfirmDelete(id: string): void {
  deleteMut.mutate(id, { onSuccess: () => deleteDialogRef.value?.close() });
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="定时任务"
      description="系统任务仅可编辑不可删除；普通任务可新增、编辑、删除，并可手动立即执行一次、查看执行日志"
    />

    <!-- 非管理员：无权限（与金融数据接口页一致：Card 居中提示） -->
    <Card v-if="!isAdmin">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">
        无权限访问该页面
      </CardContent>
    </Card>

    <!-- 任务列表：分类分页 Tab 在 Card 外（与金融数据接口页一致），框随内容切换 -->
    <template v-else>
      <Tabs v-model="listTab" class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="normal">
              <ListTodo class="mr-2 h-4 w-4" />
              普通任务
              <Badge variant="secondary" class="ml-1.5">{{ normalTasks.length }}</Badge>
            </TabsTrigger>
            <TabsTrigger value="system">
              <Settings2 class="mr-2 h-4 w-4" />
              系统任务
              <Badge variant="secondary" class="ml-1.5">{{ systemTasks.length }}</Badge>
            </TabsTrigger>
          </TabsList>
          <Button size="sm" v-if="listTab === 'normal'" @click="openCreate">
            <Plus class="mr-1 h-4 w-4" />
            新建任务
          </Button>
        </div>

        <TabsContent value="normal">
          <ScheduleTaskTable
            :tasks="normalTasks"
            :loading="isLoading"
            :empty="(tasks ?? []).length === 0"
            empty-title="暂无定时任务"
            empty-description="系统任务由系统预置且不可删除；普通任务可点击上方「新建任务」创建"
            :allow-delete="true"
            :update-pending="updateMut.isPending.value"
            :trigger-pending="triggerMut.isPending.value"
            @toggle="handleToggleEnabled"
            @edit="openEdit"
            @trigger="handleTrigger"
            @logs="handleLogs"
            @remove="handleRemove"
          />
        </TabsContent>

        <TabsContent value="system">
          <ScheduleTaskTable
            :tasks="systemTasks"
            :loading="isLoading"
            :empty="(tasks ?? []).length === 0"
            empty-title="暂无系统任务"
            empty-description="系统任务由系统预置且不可删除"
            :allow-delete="false"
            :update-pending="updateMut.isPending.value"
            :trigger-pending="triggerMut.isPending.value"
            @toggle="handleToggleEnabled"
            @edit="openEdit"
            @trigger="handleTrigger"
            @logs="handleLogs"
            @remove="handleRemove"
          />
        </TabsContent>
      </Tabs>
    </template>

    <!-- 新建 / 编辑对话框（始终挂载，显隐由 dialogOpen 控制，见组件内说明） -->
    <ScheduleTaskFormDialog
      :open="dialogOpen"
      :editing="editing"
      :edit-tab="editTab"
      :form="form"
      :creatable-handlers="creatableHandlers"
      :param-fields="paramFields"
      :has-leveled-params="hasLeveledParams"
      :pending="formPending()"
      @update:open="dialogOpen = $event"
      @update:edit-tab="editTab = $event"
      @task-type-change="onTaskTypeChange"
      @submit="handleSubmit"
      @close="close"
    />

    <!-- 删除确认 -->
    <ScheduleTaskDeleteDialog ref="deleteDialogRef" @confirm="handleConfirmDelete" />

    <!-- 执行日志 -->
    <ScheduleTaskLogsDialog ref="logsDialogRef" :tasks="tasks ?? []" />
  </div>
</template>
