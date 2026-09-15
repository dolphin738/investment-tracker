<script setup lang="ts">
/**
 * modules/admin/components/ScheduleTaskFormDialog.vue — 新建 / 编辑任务对话框
 *
 * 从 SchedulePage 抽出；表单状态机在 use-schedule-form（门面持有），本组件为受控展示层：
 * 「基础设置」（任务类型 / 名称 / 时间设置 / 描述 / 参数）与「清理规则」（分级参数 /
 * 保留日志条数）两页签。
 *
 * 始终挂载，显隐由父级 open 控制（与拆分前一致，避免 reka Dialog 在已 open 状态全新挂载
 * 时因缺少「关闭→打开」切换而不渲染内容）。
 */
import { Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import TaskParamFields from '@/modules/admin/components/TaskParamFields.vue';
import CronInput from '@/modules/admin/components/CronInput.vue';
import { TASK_KIND_LABEL } from '@/modules/admin/composables/use-schedule';
import { kindVariant } from '@/modules/admin/utils/schedule-format';
import type { EditForm } from '@/modules/admin/composables/use-schedule-form';
import type { JobHandler, ScheduleTask } from '@/api/schedule.api';

defineProps<{
  /** 对话框显隐 */
  open: boolean;
  /** 当前编辑任务（null = 新建） */
  editing: ScheduleTask | null;
  /** 当前页签（basic / rules） */
  editTab: string;
  /** 表单模型（父级 reactive，本组件就地写入字段） */
  form: EditForm;
  /** 可新建任务类型清单 */
  creatableHandlers: JobHandler[];
  /** 当前任务类型的参数字段 */
  paramFields: JobHandler['param_fields'];
  /** 当前任务类型是否含分级保留参数 */
  hasLeveledParams: boolean;
  /** 保存中（createMut / updateMut pending） */
  pending: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void;
  (e: 'update:editTab', tab: string): void;
  (e: 'task-type-change', type: string): void;
  (e: 'submit'): void;
  (e: 'close'): void;
}>();
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
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

      <Tabs
        :model-value="editTab"
        @update:model-value="(v: string) => emit('update:editTab', v)"
        class="space-y-4"
      >
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
                @update:model-value="(v: string) => emit('task-type-change', v)"
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

          <!-- 参数（无分级参数的任务在此渲染，如「交易日历刷新」的 full 开关；含分级参数的见「清理规则」页签） -->
          <div v-if="!hasLeveledParams && paramFields.length > 0" class="space-y-3">
            <Label>参数</Label>
            <TaskParamFields
              :fields="paramFields"
              :params="form.params"
              @update:param="(k, v) => (form.params[k] = v)"
            />
          </div>
        </TabsContent>

        <!-- 清理规则：分级保留参数（仅含 retention_days/max_rows 的任务可设）+ 保留日志条数（通用） -->
        <TabsContent value="rules" class="space-y-4">
          <template v-if="hasLeveledParams">
            <TaskParamFields
              :fields="paramFields"
              :params="form.params"
              @update:param="(k, v) => (form.params[k] = v)"
            />
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
        <Button variant="outline" @click="emit('close')">取消</Button>
        <Button :disabled="pending" @click="emit('submit')">
          <Loader2 v-if="pending" class="mr-2 h-4 w-4 animate-spin" />
          保存
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
