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

/** 更新某级别的值，写回 JSON 字符串并上抛 */
function setJsonKey(fkey: string, sub: string, val: string): void {
  const o = jsonObjectOf(props.params[fkey]);
  if (val.trim() === '') delete o[sub];
  else o[sub] = Number(val);
  emit('update:param', fkey, JSON.stringify(o));
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
        :model-value="params[f.key] ?? ''"
        :type="f.type === 'number' || f.type === 'integer' ? 'number' : 'text'"
        :placeholder="f.label"
        @update:model-value="(v: string | number) => emit('update:param', f.key, String(v))"
      />
    </div>
  </template>
</template>
