<script setup lang="ts">
/**
 * modules/admin/components/TaskParamFields.vue — 定时任务「参数字段」受控渲染
 *
 * 从 SchedulePage 抽出，供两处共用：清理规则页签（含分级参数的任务，如 LOG_CLEANUP）
 * 与基础设置页签（无分级参数的任务，如「交易日历刷新」的 full 开关）。
 * 不直接改 props：变更经 update:param 上抛，由父组件写回 form.params。
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { jsonFieldValue, setJsonKey } from '@/modules/admin/utils/task-params';

export interface TaskParamField {
  key: string;
  label: string;
  required?: boolean;
  type: string;
  map_of?: string[];
  default?: unknown;
}

const props = defineProps<{
  /** 参数字段元数据（来自 GET /admin/tasks/handlers 的 param_fields） */
  fields: TaskParamField[];
  /** 参数值记录（字符串承载，与父组件 form.params 同源） */
  params: Record<string, string>;
}>();

const emit = defineEmits<{
  (e: 'update:param', key: string, value: string): void;
}>();

/** 更新某级别的值：JSON 读写逻辑在 utils/task-params，这里只负责把结果上抛 */
function onSetJsonKey(fkey: string, sub: string, val: string): void {
  emit('update:param', fkey, setJsonKey(props.params[fkey], sub, val));
}
</script>

<template>
  <template v-for="f in fields" :key="f.key">
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
        :model-value="(params[f.key] ?? 'false') === 'true'"
        @update:model-value="(v: boolean) => emit('update:param', f.key, String(v))"
      />
    </div>
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
            :model-value="jsonFieldValue(params[f.key], sub)"
            type="number"
            :placeholder="String((f.default as Record<string, unknown>)?.[sub] ?? '')"
            @update:model-value="(v: string | number) => onSetJsonKey(f.key, sub, String(v))"
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
        :model-value="params[f.key] ?? ''"
        :type="f.type === 'number' || f.type === 'integer' ? 'number' : 'text'"
        :placeholder="f.label"
        @update:model-value="(v: string | number) => emit('update:param', f.key, String(v))"
      />
    </div>
  </template>
</template>
