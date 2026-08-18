<script lang="ts">
/**
 * ui/button — shadcn-vue Button（reka-ui Primitive 支持 asChild）
 * cva variants 与 React 版完全一致
 */

import { cva, type VariantProps } from 'class-variance-authority';

export const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { Primitive, type AsTag } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    variant?: NonNullable<ButtonVariants['variant']>;
    size?: NonNullable<ButtonVariants['size']>;
    /** 渲染为子元素透传的标签（如 router-link / a） */
    asChild?: boolean;
    /** asChild 为 false 时的根标签名 */
    as?: AsTag;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    variant: 'default',
    size: 'default',
    asChild: false,
    as: 'button',
    type: 'button',
  },
);

const classes = computed(() =>
  cn(buttonVariants({ variant: props.variant, size: props.size })),
);
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :type="asChild || as !== 'button' ? undefined : type"
    :class="classes"
  >
    <slot />
  </Primitive>
</template>
