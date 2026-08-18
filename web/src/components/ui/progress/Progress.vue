<script setup lang="ts">
/**
 * ui/progress — 横向进度条（原生 div 实现，与 React 版一致）
 *
 * 不依赖 reka-ui，对外 API 与 shadcn/ui 官方 Progress 兼容：
 *   <Progress :value="42" />
 *   <Progress :value="7" :max="10" />
 *   <Progress :value="null" />
 *   <Progress :value="30" indicator-class="bg-up" />
 *
 * 无障碍：role="progressbar" + aria-valuemin/max/now。
 */
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 当前进度值；null / undefined 视为不确定态（indeterminate），渲染为 0 */
    value?: number | null;
    /** 进度上限，默认 100 */
    max?: number;
    /** 填充条（indicator）额外类名，用于覆盖颜色等 */
    indicatorClassName?: string;
    class?: string;
  }>(),
  { value: null, max: 100 },
);

/** 将输入夹在 [0, max] 区间内；null / 非有限数按 0 处理 */
function clampProgress(value: number | null | undefined, max: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), max);
}

const safeMax = computed(() =>
  Number.isFinite(props.max) && props.max > 0 ? props.max : 100,
);
const current = computed(() => clampProgress(props.value, safeMax.value));
const percent = computed(() => (current.value / safeMax.value) * 100);
const isIndeterminate = computed(
  () => props.value === null || props.value === undefined,
);
</script>

<template>
  <div
    role="progressbar"
    :aria-valuemin="0"
    :aria-valuemax="safeMax"
    :aria-valuenow="isIndeterminate ? undefined : current"
    :class="cn(
      'relative h-2 w-full overflow-hidden rounded-full bg-secondary',
      props.class,
    )"
  >
    <div
      :class="cn('h-full w-full flex-1 bg-primary transition-all', props.indicatorClassName)"
      :style="{ transform: `translateX(-${100 - percent}%)` }"
    />
  </div>
</template>
