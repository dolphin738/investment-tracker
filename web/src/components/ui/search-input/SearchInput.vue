<script setup lang="ts">
/**
 * ui/search-input — 带清空小叉的搜索输入框
 *
 * 在 Input 基础上包装：左侧可选搜索图标、有值时右侧显示清空按钮。
 * v-model 绑定输入值；@clear 为清空回调（缺省直接清空 model）。
 */
import { computed } from 'vue';
import { Search, X } from 'lucide-vue-next';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 是否在左侧显示搜索图标 */
    withIcon?: boolean;
    /** 输入框原生 type */
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    class?: string;
  }>(),
  { withIcon: true },
);

const emit = defineEmits<{ clear: [] }>();

const model = defineModel<string>({ default: '' });

const hasValue = computed(() => model.value != null && String(model.value).length > 0);

/** 清空输入：通知调用方并把 model 置空（v-model 场景直接生效） */
function handleClear(): void {
  model.value = '';
  emit('clear');
}
</script>

<template>
  <div class="relative">
    <Search
      v-if="props.withIcon"
      class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      v-model="model"
      :type="props.type"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :class="cn(props.withIcon && 'pl-8', hasValue && 'pr-8', props.class)"
    />
    <button
      v-if="hasValue"
      type="button"
      aria-label="清除"
      class="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      @click="handleClear"
    >
      <X class="h-4 w-4" />
    </button>
  </div>
</template>
