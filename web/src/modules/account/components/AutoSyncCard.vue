<script setup lang="ts">
/**
 * modules/account/components/AutoSyncCard.vue — 行情自动同步卡（「我的组合」卡上方，整行）
 *
 * 普通用户可设置行情自动同步：
 * - 启用开关（Switch）+ 周期（每日/每周/每月）+ 时间（<input type="time"> "HH:MM"）
 * - 每周额外选「星期几」(weekday)、每月额外选「几号」(day_of_month)
 * - 「保存设置」提交 PUT /api/quote-sync（非启用也允许保存；保存后后端重载调度）
 * - 「立即同步」手动触发 POST /api/quote-sync/trigger
 * - 上次执行结果：状态徽标 + 时间 + 消息
 */
import { computed, ref, watch } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate } from '@/lib/utils';
import {
  useQuoteSync,
  useSetQuoteSync,
  useTriggerQuoteSync,
} from '../composables/use-quote-sync';
import type {
  QuoteSyncFrequency,
  QuoteSyncStatus,
  UserQuoteSyncConfigUpdate,
} from '@/api/quote-sync.api';

/** 周期 → 中文标签 */
const FREQUENCY_LABEL: Record<string, string> = {
  DAY: '每日',
  WEEK: '每周',
  MONTH: '每月',
};

/** 星期数组（1=周一 .. 7=周日） */
const WEEKDAY_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '7', label: '周日' },
];

/** 上次执行状态 → 徽标配色（运行中 secondary / 成功 success / 失败 destructive） */
const STATUS_VARIANT: Record<QuoteSyncStatus, 'default' | 'secondary' | 'destructive' | 'success'> = {
  RUNNING: 'secondary',
  SUCCESS: 'success',
  FAILED: 'destructive',
};

/** 上次执行状态 → 中文标签 */
const STATUS_LABEL: Record<QuoteSyncStatus, string> = {
  RUNNING: '运行中',
  SUCCESS: '成功',
  FAILED: '失败',
};

const config = useQuoteSync();
const setMutation = useSetQuoteSync();
const triggerMutation = useTriggerQuoteSync();

/** 本地表单状态（随服务端配置初始化，可编辑） */
const enabled = ref(false);
/** 周期用 string 承接 RadioGroup 的 string v-model，提交时再收窄类型 */
const frequency = ref<string>('DAY');
const time = ref('09:00');
const weekday = ref('1');
const dayOfMonth = ref('1');

/** 服务端配置加载完成后回填初始表单值 */
watch(
  () => config.data.value,
  (val) => {
    if (!val) return;
    enabled.value = val.enabled;
    frequency.value = val.frequency;
    time.value = val.time || '09:00';
    weekday.value = val.weekday != null ? String(val.weekday) : '1';
    dayOfMonth.value = val.day_of_month != null ? String(val.day_of_month) : '1';
  },
  { immediate: true },
);

/** 周期相关的必填条件是否已满足（每周需指定星期、每月需指定几号） */
const canSave = computed(
  () =>
    (frequency.value !== 'WEEK' || Boolean(weekday.value)) &&
    (frequency.value !== 'MONTH' || Boolean(dayOfMonth.value)),
);

/** 保存按钮 disabled：保存进行中或周期必填缺失 */
const saveDisabled = computed(
  () => setMutation.isPending.value || !canSave.value,
);

/** 组装提交体：仅含可写字段（user_id / last_* 只读回显不回传） */
function buildPayload(): UserQuoteSyncConfigUpdate {
  return {
    frequency: frequency.value as QuoteSyncFrequency,
    time: time.value,
    enabled: enabled.value,
    weekday: frequency.value === 'WEEK' ? Number(weekday.value) : null,
    day_of_month: frequency.value === 'MONTH' ? Number(dayOfMonth.value) : null,
  };
}

function handleSave(): void {
  setMutation.mutate(buildPayload());
}

function handleTrigger(): void {
  triggerMutation.mutate();
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">行情自动同步</CardTitle>
      <CardDescription>
        设置周期后，系统将自动同步各组合的行情数据；保存后自动重新载入调度。
      </CardDescription>
    </CardHeader>
    <CardContent>
      <!-- 加载骨架 -->
      <div v-if="config.isLoading.value" class="space-y-3">
        <div v-for="i in 3" :key="i" class="h-9 animate-pulse rounded bg-muted" />
      </div>
      <template v-else-if="config.data.value">
        <div class="flex flex-wrap items-center gap-x-8 gap-y-4">
          <!-- 启用开关 -->
          <div class="inline-flex items-center gap-2">
            <Label>启用自动同步</Label>
            <Switch v-model="enabled" />
          </div>

          <!-- 周期选择 -->
          <div class="inline-flex flex-col gap-1">
            <Label>同步周期</Label>
            <RadioGroup v-model="frequency" orientation="horizontal">
              <RadioGroupItem
                v-for="(label, key) in FREQUENCY_LABEL"
                :key="key"
                :value="key"
                :label="label"
              />
            </RadioGroup>
          </div>

          <!-- 时间选择 -->
          <div class="inline-flex items-center gap-2">
            <Label>同步时间</Label>
            <Input v-model="time" type="time" class="w-32" />
          </div>

          <!-- 每周：星期几 -->
          <div v-if="frequency === 'WEEK'" class="inline-flex flex-col gap-1">
            <Label>每星期</Label>
            <RadioGroup v-model="weekday" orientation="horizontal">
              <RadioGroupItem
                v-for="opt in WEEKDAY_OPTIONS"
                :key="opt.value"
                :value="opt.value"
                :label="opt.label"
              />
            </RadioGroup>
          </div>

          <!-- 每月：几号 -->
          <div v-if="frequency === 'MONTH'" class="inline-flex items-center gap-2">
            <Label>每月</Label>
            <Select v-model="dayOfMonth">
              <SelectTrigger class="w-32">
                <SelectValue :placeholder="'选择日期'" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="d in 31" :key="d" :value="String(d)">
                  {{ d }} 号
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- 上次执行结果 -->
          <div
            v-if="config.data.value.last_status || config.data.value.last_run_at"
            class="basis-full rounded-md border bg-muted/40 p-3 text-sm lg:basis-auto"
          >
            <div class="flex items-center gap-2">
              <span class="text-muted-foreground">上次执行</span>
              <Badge :variant="STATUS_VARIANT[config.data.value.last_status ?? 'RUNNING']">
                {{
                  config.data.value.last_status
                    ? STATUS_LABEL[config.data.value.last_status]
                    : '-'
                }}
              </Badge>
              <span v-if="config.data.value.last_run_at" class="tabular-nums text-muted-foreground">
                {{ formatDate(config.data.value.last_run_at) }}
              </span>
            </div>
            <p v-if="config.data.value.last_message" class="mt-1 truncate text-xs text-muted-foreground">
              {{ config.data.value.last_message }}
            </p>
          </div>
        </div>
      </template>
    </CardContent>
    <CardFooter class="flex gap-2">
      <Button :disabled="saveDisabled" @click="handleSave">
        <Loader2 v-if="setMutation.isPending.value" class="mr-2 h-4 w-4 animate-spin" />
        保存设置
      </Button>
      <Button variant="outline" :disabled="triggerMutation.isPending.value" @click="handleTrigger">
        <Loader2 v-if="triggerMutation.isPending.value" class="mr-2 h-4 w-4 animate-spin" />
        立即同步
      </Button>
    </CardFooter>
  </Card>
</template>