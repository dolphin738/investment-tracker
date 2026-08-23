<script setup lang="ts">
/**
 * components/common/HelpTip.vue — 行内说明气泡
 *
 * 替代散落在各页的 <p class="text-xs"> 长说明（Snapshots 图例、Transactions 筛选说明、
 * Settings 字段说明），默认收起、图标触发，降低正文噪声（治 ui-design-review.md 批次4）。
 *
 * 可访问性：触发器为原生 <button>，aria-expanded 反映展开态；展开面板 role="note"。
 */
import { ref } from 'vue';
import { HelpCircle } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

withDefaults(
  defineProps<{
    /** 触发图标旁可选的简短文字（默认仅图标） */
    label?: string;
    /** 提示文案（支持插槽 #content 覆盖） */
    text?: string;
    /** 图标尺寸档 */
    size?: 'sm' | 'md';
    /** 透传到根元素的 class */
    className?: string;
  }>(),
  { size: 'sm' },
);

const open = ref(false);
</script>

<template>
  <span :class="cn('relative inline-flex items-center align-middle', className)">
    <button
      type="button"
      :class="
        cn(
          'inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          size === 'sm' ? 'text-xs' : 'text-sm',
        )
      "
      :aria-expanded="open"
      :aria-label="label || '查看说明'"
      @click="open = !open"
    >
      <HelpCircle :class="size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'" aria-hidden="true" />
      <span v-if="label">{{ label }}</span>
    </button>

    <!-- 展开面板：绝对定位不抢占正文流；点击外部不会自动收起（保持简单可控） -->
    <span
      v-if="open"
      role="note"
      class="absolute left-0 top-full z-20 mt-1 max-w-xs rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md"
    >
      <slot name="content">{{ text }}</slot>
      <button
        type="button"
        class="ml-2 inline-flex text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label="收起说明"
        @click="open = false"
      >
        ✕
      </button>
    </span>
  </span>
</template>
