<script lang="ts">
/**
 * ui/badge — shadcn-vue Badge（纯 div，cva variants 与 React 版一致）
 */

import { cva, type VariantProps } from 'class-variance-authority';

export const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
        outline: 'text-foreground',
        success:
          'border-transparent bg-emerald-500 text-white hover:bg-emerald-500/80',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeVariants = VariantProps<typeof badgeVariants>;
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    variant?: NonNullable<BadgeVariants['variant']>;
  }>(),
  { variant: 'default' },
);

const classes = computed(() => cn(badgeVariants({ variant: props.variant })));
</script>

<template>
  <div :class="classes"><slot /></div>
</template>
