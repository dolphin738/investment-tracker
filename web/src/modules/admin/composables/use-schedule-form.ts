/**
 * modules/admin/composables/use-schedule-form.ts — 定时任务「新建 / 编辑」表单状态机
 *
 * 从 SchedulePage 抽出：表单字段、任务类型 handler 派生、参数序列化、提交。
 *
 * 4 个 mutation 实例仍由页面（门面）单例持有，其中 createMut / updateMut 注入本
 * composable —— 以保证 `updateMut.isPending` 同时驱动「表格启用开关」与「对话框保存
 * 按钮」的禁用态（若各自独立实例会出现「对话框保存中、表格开关仍可点」）。
 *
 * editTab 的持久化 key（invest:schedule-edit-tab）与「打开时重置为 basic」的语义原样保留。
 */
import { computed, reactive, ref, type Ref } from 'vue';
import { usePersistentTab } from '@/composables/use-persistent-tab';
import { jsonObjectOf } from '@/modules/admin/utils/task-params';
import type {
  JobHandler,
  JobTaskType,
  ScheduleTask,
  ScheduleTaskCreate,
  ScheduleTaskUpdate,
} from '@/api/schedule.api';

/** 新建 / 编辑表单模型（params 统一以字符串承载，提交时按 param_fields 转换） */
export interface EditForm {
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

/** 门面注入的写 mutation 单例：仅声明本 composable 所需能力（isPending / mutate） */
export interface ScheduleFormMutations {
  /** 新建任务 mutation（门面注入的单例） */
  createMut: {
    isPending: { value: boolean };
    mutate: (body: ScheduleTaskCreate, options?: { onSuccess?: () => void }) => unknown;
  };
  /** 编辑任务 mutation（门面注入的单例） */
  updateMut: {
    isPending: { value: boolean };
    mutate: (
      vars: { id: string; body: ScheduleTaskUpdate },
      options?: { onSuccess?: () => void },
    ) => unknown;
  };
}

/**
 * @param handlers   任务类型清单（来自 useTaskHandlers().data）
 * @param mutations  由门面注入的写 mutation 单例（createMut / updateMut）
 */
export function useScheduleForm(
  handlers: Ref<JobHandler[] | undefined>,
  mutations: ScheduleFormMutations,
) {
  /** 可新建任务类型（系统任务不在可建列表） */
  const creatableHandlers = computed(() => (handlers.value ?? []).filter((h) => h.creatable));

  const dialogOpen = ref(false);
  const editing = ref<ScheduleTask | null>(null);
  /** 编辑对话框分页：basic=基础设置 / rules=清理规则；持久化刷新停留 */
  const editTab = usePersistentTab('invest:schedule-edit-tab', 'basic', ['basic', 'rules'] as const);
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

  /** 当前任务类型的参数字段：分级任务渲染于「清理规则」页签，其余渲染于「基础设置」页签 */
  const paramFields = computed(() => currentHandler.value?.param_fields ?? []);

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

  const formPending = () =>
    mutations.createMut.isPending.value || mutations.updateMut.isPending.value;

  function handleSubmit(): void {
    // 名称与 cron 必填由后端校验；失败时 mutation onError 已统一提示
    // 保留条数：number 输入框写回为 number、空为 ''，统一 Number 化后仅接受正整数
    const maxLogsNum = Number(form.maxLogs);
    const maxLogsBody = Number.isInteger(maxLogsNum) && maxLogsNum > 0
      ? maxLogsNum
      : 0;
    if (editing.value) {
      const isSystem = editing.value.kind === 'SYSTEM';
      mutations.updateMut.mutate(
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
      mutations.createMut.mutate(
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

  return {
    creatableHandlers,
    dialogOpen,
    editing,
    editTab,
    form,
    paramFields,
    hasLeveledParams,
    openCreate,
    openEdit,
    close,
    onTaskTypeChange,
    formPending,
    handleSubmit,
  };
}
