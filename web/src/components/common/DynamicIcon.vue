<script setup lang="ts">
/**
 * components/common/DynamicIcon.vue — 按 lucide 图标名（字符串）动态渲染图标组件。
 *
 * 用于「接口分类」等图标名来自后端自由文本（管理员在对话框手动输入 lucide 名）的场景。
 *
 * 关键优化：用**动态 import** 按需加载全量图标命名空间，避免 `import * as LucideIcons`
 * 把整个 lucide 库（~1500 图标 / ~780KB）打进首屏共享 vendor chunk。
 * 该全量块仅在 DynamicIcon 实际挂载时（管理端「接口分类管理」板块）按需懒加载，
 * 非管理用户的首屏不再携带这部分体积。
 *
 * name 为空或库中不存在时回退到 Tag（与原有 CategoryIcon 行为一致）。
 */
import { ref, watch, type Component } from 'vue';
import { Tag } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    /** lucide 图标名，如 'LineChart' / 'ListChecks' */
    name?: string | null;
    iconClass?: string;
  }>(),
  { name: null, iconClass: 'h-4 w-4' },
);

const resolved = ref<Component | null>(null);

watch(
  () => props.name,
  async (name) => {
    resolved.value = null;
    if (!name) return;
    try {
      const mod = await import('lucide-vue-next');
      const comp = (mod as unknown as Record<string, Component>)[name];
      resolved.value = comp ?? null;
    } catch {
      resolved.value = null;
    }
  },
  { immediate: true },
);
</script>

<template>
  <component :is="resolved ?? Tag" :class="iconClass" />
</template>
