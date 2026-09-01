<script setup lang="ts">
/**
 * modules/admin/components/CronInput.vue — 定时任务「时间设置」三模式输入
 *
 * 三种方式切换（单选按钮组）：
 *   1. 固定间隔：每隔 N 分钟/小时/天，零门槛；
 *   2. 定时执行（可视化）：每天 / 每周 / 每月；
 *   3. Cron 表达式（高级模式）。
 *
 * 任何模式最终都双向绑定一个 5 字段 cron 字符串（modelValue）给后端；
 * 底部常驻「执行计划」预览（人类可读说明 + 下次执行时间），后端仍统一收 cron。
 *
 * 无副作用、无兜底错误处理；cron 合法性校验由后端 APScheduler 负责，
 * 本组件的解析与说明仅用于界面即时反馈。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { previewCron } from '@/lib/cron';

type CronMode = 'interval' | 'visual' | 'cron';
type IntervalUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';

const model = defineModel<string>({ default: '' });

/** 从既有 cron 反解出最贴合的编辑模式（识别失败回退到高级模式） */
function initModeFromCron(expr: string): {
  mode: CronMode;
  every: number;
  unit: IntervalUnit;
  freq: 'daily' | 'weekly' | 'monthly';
  weekdays: number[];
  dayOfMonth: number;
  time: string;
  cron: string;
} {
  const s = expr.trim();
  const base: ReturnType<typeof initModeFromCron> = {
    mode: 'interval',
    every: 30,
    unit: 'minute',
    freq: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    time: '08:00',
    cron: s,
  };
  // 空表达式：默认固定间隔 30 分钟
  if (!s) return base;
  // 固定间隔
  const mm = /^\*\/(\d+) \* \* \* \*$/.exec(s);
  if (mm) {
    base.mode = 'interval';
    base.unit = 'minute';
    base.every = Math.min(Number(mm[1]), 59);
    return base;
  }
  const hm = /^0 \*\/(\d+) \* \* \*$/.exec(s);
  if (hm) {
    base.mode = 'interval';
    base.unit = 'hour';
    base.every = Math.min(Number(hm[1]), 23);
    return base;
  }
  // 固定间隔（月）：每月 1 号、每隔 N 月（cron: 0 0 1 */N *）
  const mo = /^0 0 1 \*\/(\d+) \* \*$/.exec(s);
  if (mo) {
    base.mode = 'interval';
    base.unit = 'month';
    base.every = Math.min(Number(mo[1]), 12);
    return base;
  }
  const dm = /^0 0 \*\/(\d+) \* \*$/.exec(s);
  if (dm) {
    const d = Number(dm[1]);
    base.mode = 'interval';
    // 7 天倍数视为「周」间隔（cron 无独立周计数域，以 7N 天近似），其余为「天」
    if (d % 7 === 0) {
      base.unit = 'week';
      base.every = Math.min(d / 7, 52);
    } else {
      base.unit = 'day';
      base.every = Math.min(d, 31);
    }
    return base;
  }
  // 可视化：每天 / 每周 / 每月
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s);
  if (daily) {
    base.mode = 'visual';
    base.freq = 'daily';
    base.time = `${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}`;
    return base;
  }
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/.exec(s);
  if (weekly && !/\/|-/.test(weekly[3])) {
    base.mode = 'visual';
    base.freq = 'weekly';
    base.time = `${weekly[2].padStart(2, '0')}:${weekly[1].padStart(2, '0')}`;
    base.weekdays = weekly[3]
      .split(',')
      .map((x) => Number(x) % 7)
      .filter((d) => base.weekdays.includes(d) || true)
      .filter((d, i, arr) => arr.indexOf(d) === i)
      .sort((a, b) => a - b);
    return base;
  }
  const monthly = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(s);
  if (monthly) {
    base.mode = 'visual';
    base.freq = 'monthly';
    base.time = `${monthly[2].padStart(2, '0')}:${monthly[1].padStart(2, '0')}`;
    base.dayOfMonth = Math.min(Number(monthly[3]), 31);
    return base;
  }
  base.mode = 'cron';
  return base;
}

const initial = initModeFromCron(model.value);

const mode = ref<CronMode>(initial.mode);
const every = ref(initial.every);
const unit = ref<IntervalUnit>(initial.unit);
const freq = ref<'daily' | 'weekly' | 'monthly'>(initial.freq);
const weekdays = ref<number[]>(initial.weekdays);
const dayOfMonth = ref(initial.dayOfMonth);
const time = ref(initial.time);
const cronText = ref(initial.cron);

// 新增任务初始为空时，落一个可见的默认表达式（每隔 30 分钟），
// 避免用户未改动直接保存时 cron 为空触发后端必填校验。
if (!model.value.trim()) {
  model.value = buildCron();
}

/** 单位对应的取值上限（cron 步长域上限） */
const unitMax: Record<IntervalUnit, number> = { minute: 59, hour: 23, day: 31, week: 52, month: 12 };

/** 当前状态下构造的 cron 字符串（提交给后端 / 用于预览） */
function buildCron(): string {
  if (mode.value === 'interval') {
    const n = every.value;
    if (unit.value === 'minute') return `*/${n} * * * *`;
    if (unit.value === 'hour') return `0 */${n} * * *`;
    if (unit.value === 'day') return `0 0 */${n} * *`;
    // 周：cron 无独立周计数域，以 7N 天近似（每月 1 号为锚，跨月边界有 1-2 天漂移）
    if (unit.value === 'week') return `0 0 */${7 * n} * *`;
    // 月：每月 1 号、每隔 N 月
    return `0 0 1 */${n} *`;
  }
  if (mode.value === 'visual') {
    const [h, mi] = time.value.split(':');
    if (freq.value === 'daily') return `${mi} ${h} * * *`;
    if (freq.value === 'weekly') return `${mi} ${h} * * ${[...weekdays.value].sort((a, b) => a - b).join(',')}`;
    return `${mi} ${h} ${dayOfMonth.value} * *`;
  }
  return cronText.value;
}

const isCronMode = computed(() => mode.value === 'cron');

// 高级模式输入防抖：cronNextRun 为逐分钟暴力扫描（永不匹配的表达式最坏
// 57.6 万次迭代），每次击键同步重算会明显卡顿，收敛为 250ms 防抖后再预览。
const debouncedCronText = ref(cronText.value);
let cronDebounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(cronText, (val) => {
  if (cronDebounceTimer !== undefined) clearTimeout(cronDebounceTimer);
  cronDebounceTimer = setTimeout(() => {
    debouncedCronText.value = val;
  }, 250);
});
onBeforeUnmount(() => {
  if (cronDebounceTimer !== undefined) clearTimeout(cronDebounceTimer);
});

/** 底部常驻预览（说明 + 下次执行）；高级模式对输入防抖，其余模式即时 */
const preview = computed(() =>
  previewCron(isCronMode.value ? debouncedCronText.value : buildCron()),
);

/** 单位切换时收敛步长到新单位上限，避免产出非法 cron */
function onUnitChange(u: string): void {
  unit.value = u as IntervalUnit;
  if (every.value > unitMax[unit.value]) every.value = unitMax[unit.value];
}

/** 工作日切换（值 1-6 为周一至周六，0 为周日），保持非空 */
function toggleWeekday(d: number): void {
  const cur = new Set(weekdays.value);
  if (cur.has(d)) cur.delete(d);
  else cur.add(d);
  weekdays.value = Array.from(cur).sort((a, b) => a - b);
}

// 内部状态 → modelValue（杜绝回环：重新反解期间不触发写回）
let syncing = false;

// 任何内部状态变化都同步回 modelValue（即后端接收的 cron）
watch(
  [mode, every, unit, freq, weekdays, dayOfMonth, time, cronText],
  () => {
    if (syncing) return;
    model.value = buildCron();
  },
);

// 父级在每次打开对话框时会重置 modelValue（新增 / 编辑不同任务）。
// 若组件实例被复用，需据此重新反解出对应的编辑模式，避免显示陈旧状态。
watch(
  () => model.value,
  (val) => {
    if (val.trim() === buildCron()) return;
    const s = initModeFromCron(val);
    syncing = true;
    mode.value = s.mode;
    every.value = s.every;
    unit.value = s.unit;
    freq.value = s.freq;
    weekdays.value = s.weekdays;
    dayOfMonth.value = s.dayOfMonth;
    time.value = s.time;
    cronText.value = s.cron;
    syncing = false;
  },
);

/** 工作日选择顺序：周一...周六、周日 */
const WEEKDAY_ORDER = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];

const HOURS = Array.from({ length: 24 }, (_, i) => p2(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => p2(i));

function p2(n: number): string {
  return String(n).padStart(2, '0');
}
</script>

<template>
  <div class="space-y-3">
    <!-- 模式切换 -->
    <RadioGroup
      :model-value="mode"
      @update:model-value="(v: string) => (mode = v as CronMode)"
      orientation="horizontal"
      class="gap-1"
    >
      <RadioGroupItem value="interval" label="固定间隔" />
      <RadioGroupItem value="visual" label="定时执行" />
      <RadioGroupItem value="cron" label="Cron 表达式" />
    </RadioGroup>

    <!-- 固定间隔 -->
    <div v-if="mode === 'interval'" class="flex flex-wrap items-center gap-2">
      <span class="text-sm text-muted-foreground">每隔</span>
      <Select :model-value="String(every)" @update:model-value="every = Number($event)">
        <SelectTrigger class="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="n in unitMax[unit]"
            :key="n"
            :value="String(n)"
          >
            {{ n }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select :model-value="unit" @update:model-value="onUnitChange">
        <SelectTrigger class="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="minute">分钟</SelectItem>
          <SelectItem value="hour">小时</SelectItem>
          <SelectItem value="day">天</SelectItem>
          <SelectItem value="week">周</SelectItem>
          <SelectItem value="month">月</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- 定时执行（可视化） -->
    <div v-else-if="mode === 'visual'" class="space-y-3 rounded-md border p-3">
      <RadioGroup
        :model-value="freq"
        @update:model-value="(v: string) => (freq = v as 'daily' | 'weekly' | 'monthly')"
        orientation="horizontal"
      >
        <RadioGroupItem value="daily" label="每天" />
        <RadioGroupItem value="weekly" label="每周" />
        <RadioGroupItem value="monthly" label="每月" />
      </RadioGroup>

      <!-- 每周：选执行日 -->
      <div v-if="freq === 'weekly'" class="flex flex-wrap items-center gap-2">
        <Label class="text-sm text-muted-foreground">执行日</Label>
        <span
          v-for="wd in WEEKDAY_ORDER"
          :key="wd.value"
          class="inline-flex items-center"
        >
          <input
            :id="`cron-weekday-${wd.value}`"
            type="checkbox"
            class="sr-only"
            :checked="weekdays.includes(wd.value)"
            @change="toggleWeekday(wd.value)"
          />
          <label
            :for="`cron-weekday-${wd.value}`"
            class="cursor-pointer rounded border px-2 py-1 text-sm leading-none transition-colors"
            :class="weekdays.includes(wd.value) ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground'"
          >
            {{ wd.label }}
          </label>
        </span>
      </div>

      <!-- 每月：选几号 -->
      <div v-else-if="freq === 'monthly'" class="flex flex-wrap items-center gap-2">
        <Label class="text-sm text-muted-foreground">每月</Label>
        <Select :model-value="String(dayOfMonth)" @update:model-value="dayOfMonth = Number($event)">
          <SelectTrigger class="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="d in 31" :key="d" :value="String(d)">{{ d }} 号</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <!-- 执行时间 -->
      <div class="flex flex-wrap items-center gap-2">
        <Label class="text-sm text-muted-foreground">执行时间</Label>
        <Select :model-value="time.split(':')[0]" @update:model-value="time = `${$event}:${time.split(':')[1]}`">
          <SelectTrigger class="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="h in HOURS" :key="h" :value="h">{{ h }}</SelectItem>
          </SelectContent>
        </Select>
        <span class="text-muted-foreground">:</span>
        <Select :model-value="time.split(':')[1]" @update:model-value="time = `${time.split(':')[0]}:${$event}`">
          <SelectTrigger class="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in MINUTES" :key="m" :value="m">{{ m }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- Cron 表达式（高级模式） -->
    <div v-else class="space-y-1">
      <Input
        v-model="cronText"
        placeholder="0 3 * * 1-5"
        aria-label="cron 表达式"
      />
      <p v-if="!isCronMode" class="text-xs text-muted-foreground">
        切换固定间隔 / 定时执行后，底部预览会自动生成对应表达式
      </p>
    </div>

    <!-- 底部常驻预览 -->
    <div class="space-y-1 rounded-md border bg-muted/40 p-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-sm font-medium">执行计划</span>
        <code class="overflow-x-auto text-xs text-muted-foreground">{{ buildCron() || '空' }}</code>
      </div>
      <p class="text-sm text-muted-foreground">{{ preview.plan }}</p>
      <p v-if="preview.next" class="text-xs text-muted-foreground">
        下次执行预览：{{ preview.next }}
      </p>
      <p v-else class="text-xs text-destructive">表达式无效或近期无匹配，请检查后重试</p>
    </div>
  </div>
</template>