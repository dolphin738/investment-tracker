<script setup lang="ts">
/**
 * modules/admin/pages/SchedulePage.vue — 定时任务管理页（仅管理员可见）
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
 */
import { computed, reactive, ref, watch } from 'vue';
import { Loader2, Pencil, Play, Plus, ScrollText, Trash2 } from 'lucide-vue-next';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariants } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  JobKind,
  JobRunStatus,
  JobTaskType,
  ScheduleTask,
  TaskLogQuery,
} from '@/api/schedule.api';
import {
  TASK_KIND_LABEL,
  TASK_KIND_VARIANT,
  TASK_TYPE_LABEL,
  TRIGGER_SOURCE_LABEL,
  RUN_STATUS_VARIANT,
  useCreateTask,
  useDeleteTask,
  useTaskHandlers,
  useTaskLogs,
  useTasks,
  useTriggerTask,
  useUpdateTask,
} from '../composables/use-schedule';
import { useIsAdmin } from '@/stores/auth.store';
import CronInput from '../components/CronInput.vue';
import { describeCron } from '@/lib/cron';

const isAdmin = useIsAdmin();

const { data: tasks, isLoading } = useTasks();
const { data: handlers } = useTaskHandlers();

/** 列表分类分页：普通任务（NORMAL）在前、系统任务（SYSTEM）在后 */
const normalTasks = computed(() => (tasks.value ?? []).filter((t) => t.kind === 'NORMAL'));
const systemTasks = computed(() => (tasks.value ?? []).filter((t) => t.kind === 'SYSTEM'));
const listTab = ref<'normal' | 'system'>('normal');
const createMut = useCreateTask();
const updateMut = useUpdateTask();
const deleteMut = useDeleteTask();
const triggerMut = useTriggerTask();

/** 可新建任务类型（系统任务不在可建列表） */
const creatableHandlers = computed(() => (handlers.value ?? []).filter((h) => h.creatable));

// ---------------------------------------------------------------------------
// 新建 / 编辑对话框
// ---------------------------------------------------------------------------
interface EditForm {
  taskType: string;
  name: string;
  cronExpr: string;
  description: string;
  /** 保留执行日志条数上限（number 输入框写回为 number，空为 ''，均表示不限制） */
  maxLogs: number | string;
  enabled: boolean;
  /** 按 handler.param_fields 的 key 编辑的参数值（统一以字符串承载，提交时转换） */
  params: Record<string, string>;
}

const dialogOpen = ref(false);
const editing = ref<ScheduleTask | null>(null);
/** 编辑对话框分页：basic=基础设置 / rules=清理规则 */
const editTab = ref<'basic' | 'rules'>('basic');
const form = reactive<EditForm>({
  taskType: '',
  name: '',
  cronExpr: '',
  description: '',
  maxLogs: '',
  enabled: true,
  params: {},
});

/** 当前所选任务类型的 handler 元数据（含 param_fields）；编辑系统任务同样按此渲染只读参数 */
const currentHandler = computed(() =>
  handlers.value?.find((h) => h.task_type === form.taskType),
);

/** 由默认值生成参数字符串记录 */
function defaultsOf(taskTypeToken: string): Record<string, string> {
  const h = handlers.value?.find((x) => x.task_type === taskTypeToken);
  const out: Record<string, string> = {};
  h?.param_fields.forEach((f) => {
    if (f.default != null) out[f.key] = String(f.default);
  });
  return out;
}

/**
 * 当前任务类型是否含「分级保留」参数（各级别保留天数 / 各级别保留条数上限）。
 * 仅 LOG_CLEANUP 等含 retention_days / max_rows 的任务为 true；
 * 证券主数据同步等无分级参数的任务为 false，清理规则页将禁止（不渲染）这些分级项。
 */
const hasLeveledParams = computed(() => {
  const keys = (currentHandler.value?.param_fields ?? []).map((f) => f.key);
  return keys.includes('retention_days') || keys.includes('max_rows');
});

/**
 * JSON 对象参数（type=json 且含 map_of）的辅助读写。
 * 表单内部以「JSON 字符串」承载（与 number 输入框承载数字字符串的交互一致），
 * 由以下函数在「JSON 字符串 ↔ 各级别数字」之间转换。
 */
/** 把表单里存的 JSON 字符串解析成对象；非法时回退空对象 */
function jsonObjectOf(raw: unknown): Record<string, number> {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        return o as Record<string, number>;
      }
    } catch {
      /* 忽略非法 JSON，回退空对象 */
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, number>;
  }
  return {};
}
/** 取某级别当前值（数字转字符串，供 input 显示） */
function jsonFieldValue(raw: unknown, sub: string): string {
  const o = jsonObjectOf(raw);
  const v = o[sub];
  return v == null ? '' : String(v);
}
/** 更新某级别的值，写回 JSON 字符串 */
function setJsonKey(fkey: string, sub: string, val: string): void {
  const o = jsonObjectOf(form.params[fkey]);
  if (val.trim() === '') delete o[sub];
  else o[sub] = Number(val);
  form.params[fkey] = JSON.stringify(o);
}

/** 打开时按目标初始化表单（新增取第一个可建类型；编辑取其参数）。同步执行，避免受控时序 */
function initFormFor(t: ScheduleTask | null): void {
  if (t) {
    form.taskType = t.task_type;
    form.name = t.name;
    form.cronExpr = t.cron_expr;
    form.description = t.description ?? '';
    form.maxLogs = t.max_logs != null ? t.max_logs : '';
    form.enabled = t.enabled;
    form.params = Object.fromEntries(
      Object.entries(t.params ?? {}).map(([k, v]) => [
        k,
        v == null ? '' : typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : String(v),
      ]),
    );
  } else {
    const first = creatableHandlers.value[0];
    form.taskType = first?.task_type ?? '';
    form.name = '';
    form.cronExpr = '';
    form.description = '';
    form.maxLogs = '';
    form.enabled = true;
    form.params = first ? defaultsOf(first.task_type) : {};
  }
}

function openCreate(): void {
  initFormFor(null);
  editing.value = null;
  editTab.value = 'basic';
  dialogOpen.value = true;
}
function openEdit(task: ScheduleTask): void {
  initFormFor(task);
  editing.value = task;
  editTab.value = 'basic';
  dialogOpen.value = true;
}
function close(): void {
  dialogOpen.value = false;
  editing.value = null;
}

/** 切换任务类型：重置参数为该类型默认值（v-model 已更新 form.taskType） */
function onTaskTypeChange(type: string): void {
  form.params = defaultsOf(type);
}

/** 将参数字符串记录按 param_fields 类型转换为提交值（空且非必填则跳过） */
function parseParams(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  currentHandler.value?.param_fields.forEach((f) => {
    const raw = (form.params[f.key] ?? '').trim();
    if (f.type === 'json' && f.map_of) {
      // 对象参数：解析回完整 map，空级别回落默认值，确保后端收到完整 {error,warning,info}
      const parsed = jsonObjectOf(raw);
      const def = (f.default ?? {}) as Record<string, unknown>;
      const full: Record<string, unknown> = {};
      f.map_of.forEach((sub) => {
        const v = parsed[sub];
        full[sub] = v != null ? Number(v) : (def[sub] ?? 0);
      });
      out[f.key] = full;
      return;
    }
    if (!raw && !f.required) return;
    if (f.type === 'number') out[f.key] = Number(raw || f.default);
    else if (f.type === 'integer') out[f.key] = parseInt(raw || String(f.default), 10);
    else if (f.type === 'boolean') out[f.key] = raw === 'true';
    else out[f.key] = raw;
  });
  return out;
}

const formPending = () => createMut.isPending.value || updateMut.isPending.value;

function handleSubmit(): void {
  // 名称与 cron 必填由后端校验；失败时 mutation onError 已统一提示
  // 保留条数：number 输入框写回为 number、空为 ''，统一 Number 化后仅接受正整数
  const maxLogsNum = Number(form.maxLogs);
  const maxLogsBody = Number.isInteger(maxLogsNum) && maxLogsNum > 0
    ? maxLogsNum
    : 0;
  if (editing.value) {
    const isSystem = editing.value.kind === 'SYSTEM';
    updateMut.mutate(
      {
        id: editing.value.id,
        body: {
          name: form.name.trim(),
          // 普通任务可改类型；系统任务类型只读，不提交（后端亦拒绝）
          task_type: isSystem ? undefined : (form.taskType as JobTaskType),
          cron_expr: form.cronExpr.trim(),
          enabled: form.enabled,
          params: parseParams(),
          description: form.description.trim() || undefined,
          max_logs: maxLogsBody,
        },
      },
      { onSuccess: () => close() },
    );
  } else {
    createMut.mutate(
      {
        name: form.name.trim(),
        task_type: form.taskType as JobTaskType,
        cron_expr: form.cronExpr.trim(),
        enabled: form.enabled,
        params: parseParams(),
        description: form.description.trim() || undefined,
        max_logs: maxLogsBody,
      },
      { onSuccess: () => close() },
    );
  }
}

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

// ---------------------------------------------------------------------------
// 删除确认（reka-ui AlertDialogAction 时序坑）
// ---------------------------------------------------------------------------
const deleteId = ref<string | null>(null);

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
 * 同步清空 deleteId 会让确认 handler 读不到删除目标，故延迟到微任务（对齐
 * ProviderInterfaces / PortfolioManagementCard 模式）。
 */
function handleDeleteDialogOpenChange(open: boolean): void {
  if (!open) {
    queueMicrotask(() => (deleteId.value = null));
  }
}

// ---------------------------------------------------------------------------
// 执行日志（Dialog + 分页）
// ---------------------------------------------------------------------------
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
  tasks.value?.find((t) => t.id === logsTaskId.value) ?? null,
);

function openLogs(task: ScheduleTask): void {
  logsTaskId.value = task.id;
  logPage.value = 1;
}
function closeLogs(): void {
  logsTaskId.value = null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** Badge 组件的变体联合类型（用于把 string 映射常量收窄） */
type BadgeVariant = NonNullable<BadgeVariants['variant']>;

/** 归类徽标变体（SYSTEM 主色 / NORMAL 中性色） */
function kindVariant(kind: JobKind): BadgeVariant {
  return TASK_KIND_VARIANT[kind] as BadgeVariant;
}

/** 最近执行状态徽标变体 */
function runVariant(status: JobRunStatus): BadgeVariant {
  return RUN_STATUS_VARIANT[status] as BadgeVariant;
}

/** 本地时间格式化：YYYY-MM-DD HH:mm:ss（项目 utils 仅有 dates，无 datetime） */
function formatDateTime(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusLabel(status: string | null): string {
  if (status === 'RUNNING') return '执行中';
  if (status === 'SUCCESS') return '成功';
  if (status === 'FAILED') return '失败';
  return '未执行';
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="定时任务"
      description="系统任务仅可编辑不可删除；普通任务可新增、编辑、删除，并可手动立即执行一次、查看执行日志"
    >
      <template #actions>
        <Button v-if="isAdmin" size="sm" @click="openCreate">
          <Plus class="mr-1 h-4 w-4" />
          新建任务
        </Button>
      </template>
    </PageHeader>

    <!-- 非管理员：无权限 -->
    <Card v-if="!isAdmin">
      <CardContent>
        <EmptyState
          title="无权限访问该页面"
          description="定时任务管理仅对系统管理员开放"
        />
      </CardContent>
    </Card>

    <!-- 任务列表 -->
    <Card v-else>
      <CardContent>
        <TableSkeleton v-if="isLoading" :rows="6" :cols="7" class="py-2" />
        <EmptyState
          v-else-if="(tasks ?? []).length === 0"
          title="暂无定时任务"
          description="点击右上角「新建任务」创建普通任务；系统任务由系统预置且不可删除"
        />
        <div v-else>
          <!-- 分类分页：普通任务在前、系统任务在后 -->
          <Tabs v-model="listTab" class="space-y-3">
            <TabsList class="grid w-full grid-cols-2">
              <TabsTrigger value="normal">
                普通任务
                <Badge variant="secondary" class="ml-1.5">{{ normalTasks.length }}</Badge>
              </TabsTrigger>
              <TabsTrigger value="system">
                系统任务
                <Badge variant="secondary" class="ml-1.5">{{ systemTasks.length }}</Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="normal" class="space-y-0">
              <Table class="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-[180px] whitespace-nowrap">名称</TableHead>
                    <TableHead class="w-[130px] whitespace-nowrap">类型</TableHead>
                    <TableHead class="w-[100px] whitespace-nowrap">归类</TableHead>
                    <TableHead class="w-16 whitespace-nowrap">启用</TableHead>
                    <TableHead class="w-[120px] whitespace-nowrap">cron</TableHead>
                    <TableHead class="w-[180px] whitespace-nowrap">最近一次执行</TableHead>
                    <TableHead class="w-[180px] whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="task in normalTasks" :key="task.id">
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
                    :disabled="updateMut.isPending.value"
                    @update:model-value="(v: boolean) => handleToggleEnabled(task, v)"
                  />
                </TableCell>
                <TableCell class="whitespace-nowrap align-middle">
                  <span class="text-sm" :title="task.cron_expr">
                    {{ describeCron(task.cron_expr) ?? task.cron_expr }}
                  </span>
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
                    <Button variant="ghost" size="sm" @click="openEdit(task)">
                      <Pencil class="mr-1 h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      :disabled="triggerMut.isPending.value"
                      title="立即执行一次"
                      @click="handleTrigger(task)"
                    >
                      <Play class="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="查看执行日志"
                      @click="openLogs(task)"
                    >
                      <ScrollText class="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      v-if="task.kind === 'NORMAL'"
                      variant="ghost"
                      size="sm"
                      class="text-red-500 hover:text-red-600"
                      title="删除任务"
                      @click="deleteId = task.id"
                    >
                      <Trash2 class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          </TabsContent>

          <TabsContent value="system" class="space-y-0">
            <Table class="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead class="w-[180px] whitespace-nowrap">名称</TableHead>
                  <TableHead class="w-[130px] whitespace-nowrap">类型</TableHead>
                  <TableHead class="w-[100px] whitespace-nowrap">归类</TableHead>
                  <TableHead class="w-16 whitespace-nowrap">启用</TableHead>
                  <TableHead class="w-[120px] whitespace-nowrap">cron</TableHead>
                  <TableHead class="w-[180px] whitespace-nowrap">最近一次执行</TableHead>
                  <TableHead class="w-[180px] whitespace-nowrap text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="task in systemTasks" :key="task.id">
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
                      :disabled="updateMut.isPending.value"
                      @update:model-value="(v: boolean) => handleToggleEnabled(task, v)"
                    />
                  </TableCell>
                  <TableCell class="whitespace-nowrap align-middle">
                    <span class="text-sm" :title="task.cron_expr">
                      {{ describeCron(task.cron_expr) ?? task.cron_expr }}
                    </span>
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
                      <Button variant="ghost" size="sm" @click="openEdit(task)">
                        <Pencil class="mr-1 h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        :disabled="triggerMut.isPending.value"
                        title="立即执行一次"
                        @click="handleTrigger(task)"
                      >
                        <Play class="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="查看执行日志"
                        @click="openLogs(task)"
                      >
                        <ScrollText class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TabsContent>
          </Tabs>
        </div>
      </CardContent>
    </Card>

    <!-- 新建 / 编辑对话框 -->
    <!--
      始终挂载 Dialog，改用 reka 原生的 v-model:open 双向绑定控制显隐（关闭时 reka 会
      把 open 置 false，无需再手动同步）。不使用 v-if 全量卸载重挂，避免 reka Dialog
      在已 open 状态下全新挂载时因缺少「关闭→打开」切换而不渲染内容。
    -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent class="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ editing ? '编辑任务' : '新建任务' }}</DialogTitle>
          <DialogDescription>
            {{
              editing
                ? '修改任务配置；系统任务的类型与归类只读'
                : '按所选任务类型填写执行计划与参数'
            }}
          </DialogDescription>
        </DialogHeader>

        <Tabs v-model="editTab" class="space-y-4">
          <TabsList class="grid w-full grid-cols-2">
            <TabsTrigger value="basic">基础设置</TabsTrigger>
            <TabsTrigger value="rules">清理规则</TabsTrigger>
          </TabsList>

          <!-- 基础设置：任务类型 / 名称 / 描述 / 时间设置 / 启用 / 保留日志 -->
          <TabsContent value="basic" class="space-y-4">
            <div class="space-y-2">
              <Label>任务类型</Label>
              <div class="flex items-center gap-3">
                <Select
                  v-model="form.taskType"
                  :disabled="editing?.kind === 'SYSTEM'"
                  @update:model-value="onTaskTypeChange"
                >
                  <SelectTrigger class="flex-1">
                    <SelectValue placeholder="选择任务类型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="h in creatableHandlers"
                      :key="h.task_type"
                      :value="h.task_type"
                    >
                      {{ h.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Badge v-if="editing" :variant="kindVariant(editing.kind)">
                  {{ TASK_KIND_LABEL[editing.kind] ?? editing.kind }}
                </Badge>
              </div>
            </div>

            <div class="space-y-2">
              <Label for="schedule-name">名称</Label>
              <Input id="schedule-name" v-model="form.name" placeholder="如 收盘行情同步" />
            </div>

            <div class="space-y-2">
              <Label>时间设置</Label>
              <CronInput :key="editing ? editing.id : 'new'" v-model="form.cronExpr" />
            </div>

            <div class="space-y-2">
              <Label for="schedule-desc">描述 <span class="text-xs text-muted-foreground">（可选）</span></Label>
              <Textarea
                id="schedule-desc"
                v-model="form.description"
                placeholder="备注任务用途"
                :rows="3"
              />
            </div>
          </TabsContent>

          <!-- 清理规则：分级保留参数（仅含 retention_days/max_rows 的任务可设）+ 保留日志条数（通用） -->
          <TabsContent value="rules" class="space-y-4">
            <template v-if="hasLeveledParams">
              <template v-for="f in currentHandler?.param_fields ?? []" :key="f.key">
                <div
                  v-if="f.type === 'boolean'"
                  class="flex items-center justify-between rounded-md border p-3"
                >
                  <Label :for="`param-${f.key}`" class="text-sm">
                    {{ f.label }}
                    <span v-if="f.required" class="text-destructive"> *</span>
                  </Label>
                  <Switch
                    :id="`param-${f.key}`"
                    :model-value="(form.params[f.key] ?? 'false') === 'true'"
                    @update:model-value="(v: boolean) => (form.params[f.key] = String(v))"
                  />
                </div>
                <!-- JSON 对象参数（map_of）：渲染为各级别独立 number 输入框，与"已读通知保留天数"样式一致 -->
                <div v-else-if="f.type === 'json' && f.map_of" class="space-y-2">
                  <Label :for="`param-${f.key}`">
                    {{ f.label }}
                    <span v-if="f.required" class="text-destructive"> *</span>
                  </Label>
                  <div class="grid grid-cols-3 gap-3">
                    <div v-for="sub in f.map_of" :key="sub" class="space-y-1">
                      <span class="text-xs text-muted-foreground">{{ sub }}</span>
                      <Input
                        :id="`param-${f.key}-${sub}`"
                        :model-value="jsonFieldValue(form.params[f.key], sub)"
                        :type="'number'"
                        :placeholder="String((f.default as Record<string, unknown>)?.[sub] ?? '')"
                        @update:model-value="(v: string | number) => setJsonKey(f.key, sub, String(v))"
                      />
                    </div>
                  </div>
                </div>
                <div v-else class="space-y-2">
                  <Label :for="`param-${f.key}`">
                    {{ f.label }}
                    <span v-if="f.required" class="text-destructive"> *</span>
                  </Label>
                  <Input
                    :id="`param-${f.key}`"
                    v-model="form.params[f.key]"
                    :type="f.type === 'number' || f.type === 'integer' ? 'number' : 'text'"
                    :placeholder="f.label"
                  />
                </div>
              </template>
            </template>
            <p v-else class="text-sm text-muted-foreground">
              该任务无分级保留规则，仅可设置下方执行日志保留条数。
            </p>

            <div class="space-y-2">
              <Label for="schedule-maxlogs">
                保留执行日志条数
                <span class="text-muted-foreground">（留空不限制）</span>
              </Label>
              <Input
                id="schedule-maxlogs"
                v-model="form.maxLogs"
                type="number"
                min="1"
                step="1"
                placeholder="如 100，最多保留最近 100 条执行日志"
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" @click="close">取消</Button>
          <Button :disabled="formPending()" @click="handleSubmit">
            <Loader2 v-if="formPending()" class="mr-2 h-4 w-4 animate-spin" />
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <AlertDialog
      :open="deleteId !== null"
      @update:open="handleDeleteDialogOpenChange"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该定时任务？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后不可恢复，且该任务将不再按计划执行。
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

    <!-- 执行日志 -->
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
  </div>
</template>