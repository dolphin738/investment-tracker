<script setup lang="ts">
/**
 * components/common/SecuritySearchCombobox.vue — 证券搜索选择框（§7 ④ / §10，全站复用）
 *
 * 平移自 React 版 components/security/security-search-combobox.tsx。受控 Input：
 * 键入即防抖搜索系统主数据（GET /api/admin/securities/masters?q=，匹配 code /
 * name / 拼音首字母），下拉候选点击选中后回调 onSelect(master)。当前选中项的
 * 展示文本由父级经 `value` 传入（如「贵州茅台（600519）」）；用户开始输入时切换
 * 为搜索态，输入框显示键入内容。
 *
 * 实现说明：Input + 内联下拉实现（零新增依赖），功能契约与 React 版一致。
 */

import { computed, ref, watch } from 'vue';
import { onUnmounted } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Loader2, Search, X } from 'lucide-vue-next';
import { Input } from '@/components/ui/input';
import {
  listSecurityMasters,
  type SecurityMaster,
} from '@/api/security-master.api';

const props = withDefaults(
  defineProps<{
    /** 当前选中项的展示文本（编辑态回显，如「贵州茅台（600519）」） */
    value?: string;
    /** 选中系统主数据候选后回调（由调用方调 resolve 实例化为组合标的） */
    onSelect: (master: SecurityMaster) => void;
    /** 点击清空小叉时回调（由调用方清掉已选标的 securityId） */
    onClear?: () => void;
    disabled?: boolean;
    placeholder?: string;
    id?: string;
  }>(),
  {
    value: '',
    onClear: undefined,
    disabled: false,
    placeholder: '搜索代码 / 名称 / 拼音首字母',
    id: undefined,
  },
);

// 兼容 prop 回调与 emit 事件两种调用方式（DividendForm 用 :on-select/:on-clear，
// SecurityTradeForm 用 @select/@clear），两者等价
const emit = defineEmits<{
  select: [master: SecurityMaster];
  clear: [];
}>();

const SEARCH_DEBOUNCE_MS = 250;

const query = ref('');
const open = ref(false);
const debouncedQ = ref('');

// 防抖：键入 250ms 后触发搜索
watch(query, (val) => {
  const t = setTimeout(() => {
    debouncedQ.value = val.trim();
  }, SEARCH_DEBOUNCE_MS);
  // watch 无取消句柄；用一个定时器变量避免多次叠加
  queryTimer = t;
});
let queryTimer: ReturnType<typeof setTimeout> | undefined;
// 组件卸载时清理定时器
onUnmounted(() => {
  if (queryTimer) clearTimeout(queryTimer);
});

const { data, isFetching } = useQuery({
  queryKey: computed(() => ['security-master', 'search', debouncedQ.value]),
  queryFn: () => listSecurityMasters({ q: debouncedQ.value, pageSize: 20 }),
  enabled: computed(() => open.value && debouncedQ.value.length > 0),
  staleTime: 30 * 1000,
});

const candidates = computed(() => data.value?.items ?? []);
const searching = computed(() => open.value && debouncedQ.value.length > 0);

function handlePick(master: SecurityMaster): void {
  props.onSelect(master);
  query.value = '';
  debouncedQ.value = '';
  open.value = false;
}

// 点击候选时容器 blur 可能先触发；用 mousedown 阻止默认，保证 click 可命中
function handleContainerMousedown(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('[data-security-candidate]')) {
    e.preventDefault();
  }
}

function handleClear(): void {
  query.value = '';
  debouncedQ.value = '';
  open.value = false;
  props.onClear?.();
  emit('clear');
}

// 模板内使用 window / setTimeout 会在模板作用域解析为组件实例属性，故抽为具名函数
function handleBlur(): void {
  setTimeout(() => {
    open.value = false;
  }, 150);
}
</script>

<template>
  <div class="relative" @mousedown="handleContainerMousedown">
    <div class="relative">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        :id="props.id"
        class="pl-8 pr-8"
        :placeholder="props.placeholder"
        :disabled="props.disabled"
        :model-value="searching ? query : props.value"
        @update:model-value="(v: string | number) => { query = String(v); open = true; }"
        @focus="() => { if (query) open = true; }"
        @blur="handleBlur"
      />
      <button
        v-if="(searching ? query : props.value) && !props.disabled"
        type="button"
        aria-label="清除"
        class="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        @click="handleClear"
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <!-- 搜索下拉候选 -->
    <div
      v-if="searching"
      class="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <div v-if="isFetching" class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 class="h-3.5 w-3.5 animate-spin" /> 搜索中…
      </div>
      <p v-else-if="candidates.length === 0" class="px-3 py-2 text-sm text-muted-foreground">
        无匹配结果
      </p>
      <template v-else>
        <button
          v-for="s in candidates"
          :key="s.id"
          type="button"
          data-security-candidate
          class="flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          @click="handlePick(s)"
        >
          <span class="truncate">
            <span class="font-medium">{{ s.name }}</span>
            <span class="ml-2 font-mono text-xs text-muted-foreground">{{ s.code }}</span>
          </span>
          <span class="shrink-0 text-xs text-muted-foreground">
            {{ [s.exchange, s.assetClass].filter(Boolean).join(' · ') || '—' }}
          </span>
        </button>
      </template>
    </div>
  </div>
</template>