/**
 * modules/admin/utils/schedule-format.ts — 定时任务展示格式化（Table / LogsDialog / FormDialog 共用）
 *
 * 从 SchedulePage 抽出：归类徽标、最近执行状态徽标、执行状态中文标签、cron 悬浮说明。
 * 拆分前这些函数定义在页面内并被任务表格与「执行日志」弹窗复用，抽出后由各组件直接
 * import，避免逐字重复。纯展示映射，无副作用。
 */
import { type BadgeVariants } from '@/components/ui/badge';
import { describeCron } from '@/lib/cron';
import {
  RUN_STATUS_VARIANT,
  TASK_KIND_VARIANT,
} from '@/modules/admin/composables/use-schedule';
import type { JobKind, JobRunStatus, ScheduleTask } from '@/api/schedule.api';

/** Badge 组件的变体联合类型（用于把 string 映射常量收窄） */
export type BadgeVariant = NonNullable<BadgeVariants['variant']>;

/** 归类徽标变体（SYSTEM 主色 / NORMAL 中性色） */
export function kindVariant(kind: JobKind): BadgeVariant {
  return TASK_KIND_VARIANT[kind] as BadgeVariant;
}

/** 最近执行状态徽标变体 */
export function runVariant(status: JobRunStatus): BadgeVariant {
  return RUN_STATUS_VARIANT[status] as BadgeVariant;
}

/** 执行状态中文标签（未知 / null 回落「未执行」） */
export function statusLabel(status: string | null): string {
  if (status === 'RUNNING') return '执行中';
  if (status === 'SUCCESS') return '成功';
  if (status === 'FAILED') return '失败';
  return '未执行';
}

/** cron 单元格悬浮提示：优先展示完整中文说明，回退原始表达式 */
export function cronTitle(task: ScheduleTask): string {
  return describeCron(task.cron_expr) ?? task.cron_expr;
}
