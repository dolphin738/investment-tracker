<script lang="ts">
/**
 * ui/alert — 提示条（cva variants，类名与 React 版一致）
 *
 * 无 reka-ui 依赖，纯 div 实现，支持 default / destructive / warning 三种样式。
 */

import { cva, type VariantProps } from 'class-variance-authority';

export const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'border-destructive/50 text-destructive [&>svg]:text-destructive',
        warning:
          'border-amber-500/50 bg-amber-50 text-amber-900 [&>svg]:text-amber-600 dark:bg-amber-950/30 dark:text-amber-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type AlertVariants = VariantProps<typeof alertVariants>;
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    variant?: NonNullable<AlertVariants['variant']>;
    class?: string;
  }>(),
  { variant: 'default' },
);

const classes = computed(() =>
  cn(alertVariants({ variant: props.variant }), props.class),
);
</script>

<template>
  <div role="alert" :class="classes">
    <slot />
  </div>
</template>
