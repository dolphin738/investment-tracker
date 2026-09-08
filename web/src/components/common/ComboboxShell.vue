<script setup lang="ts">
/**
 * components/common/ComboboxShell.vue — 搜索选择框通用交互外壳（全站复用）
 *
 * 2026-09-09 自 SecuritySearchCombobox / ImpliedPriceCalculator 的重复交互骨架
 * 抽取（审查 M-1 / 债务收口），并补齐键盘导航与 ARIA（审查 L-1）：
 * - 受控输入：非搜索态回显 props.value，键入切搜索态；输入文本经 @search 抛出
 *   （父级据此本地过滤或防抖远程搜索）；
 * - 下拉容器：loading / error / empty / 候选（默认插槽）四态；候选数量经
 *   candidateCount 传入，渲染完全由父级经插槽完成；
 * - openOnFocus=true 为「本地浏览」模式（聚焦即展开全部候选，如股息价格推算）；
 *   默认「远程搜索」模式（键入才展开，如证券主数据搜索）；
 * - 键盘：↓/↑ 移动激活项、Enter 确认（@select-index）、Esc 关闭；
 * - ARIA：role=combobox + aria-expanded/aria-autocomplete/aria-activedescendant；
 *   候选项经插槽作用域 optId(i) 绑定 id，父级加 role=option + aria-selected；
 * - 选中后外壳自动复位（清输入、关下拉）：点击候选由容器 click 捕获统一触发、
 *   Enter 在 keydown 内触发——父级候选 @click 只需更新选中值；
 * - blur 150ms 延迟关闭 + mousedown 防抢（[data-combobox-candidate]），沿用既有范式。
 */
import { computed, ref, watch } from 'vue';
import { Loader2, Search, X } from 'lucide-vue-next';
import { Input } from '@/components/ui/input';

const props = withDefaults(
  defineProps<{
    /** 非搜索态回显文本（父级选中项展示，如「贵州茅台（600519）」） */
    value?: string;
    placeholder?: string;
    id?: string;
    disabled?: boolean;
    /** 下拉加载中（展示 Loading 行） */
    loading?: boolean;
    /** 下拉加载失败（展示 errorText，避免误显「无匹配结果」） */
    error?: boolean;
    errorText?: string;
    emptyText?: string;
    /** 候选数量（供键盘导航与 empty 判定；候选由默认插槽渲染） */
    candidateCount?: number;
    /** 聚焦即展开候选（本地浏览模式）；默认键入才展开（远程搜索模式） */
    openOnFocus?: boolean;
  }>(),
  {
    value: '',
    placeholder: '搜索代码 / 名称',
    id: undefined,
    disabled: false,
    loading: false,
    error: false,
    errorText: '加载失败，请重试',
    emptyText: '无匹配结果',
    candidateCount: 0,
    openOnFocus: false,
  },
);

const emit = defineEmits<{
  /** 输入变化（父级据此本地过滤或防抖远程搜索） */
  search: [query: string];
  /** 键盘 Enter 确认激活项（索引，父级映射到候选数组） */
  selectIndex: [index: number];
  /** 点击清除叉 */
  clear: [];
}>();

const query = ref('');
const open = ref(false);
const activeIndex = ref(-1);

/** 搜索态：已键入非空白内容 */
const searching = computed(() => query.value.trim().length > 0);
/** 下拉可见：已展开 且（浏览模式 或 已键入） */
const dropdownVisible = computed(
  () => open.value && (props.openOnFocus || searching.value),
);

/** 候选项 DOM id（父级插槽经 optId(i) 绑定，供 aria-activedescendant 引用） */
function optId(i: number): string {
  return `${props.id ?? 'combobox'}-opt-${i}`;
}

function handleInput(v: string | number): void {
  query.value = String(v);
  open.value = true;
  activeIndex.value = -1;
  emit('search', query.value);
}

function handleFocus(): void {
  if (props.openOnFocus || query.value) open.value = true;
}

/** 选中后复位：清输入、关下拉（点击候选经容器 click 统一触发；Enter 在 keydown 触发） */
function reset(): void {
  query.value = '';
  open.value = false;
  activeIndex.value = -1;
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!dropdownVisible.value) {
      open.value = true;
      return;
    }
    if (props.candidateCount > 0) {
      activeIndex.value = Math.min(activeIndex.value + 1, props.candidateCount - 1);
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, -1);
  } else if (e.key === 'Enter') {
    if (activeIndex.value >= 0) {
      e.preventDefault();
      const i = activeIndex.value;
      reset();
      emit('selectIndex', i);
    }
  } else if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault();
      open.value = false;
    }
  }
}

function handleClear(): void {
  reset();
  emit('clear');
}

/** 点击候选时容器 blur 可能先触发；mousedown 阻止默认，保证 click 可命中（既有范式） */
function handleContainerMousedown(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('[data-combobox-candidate]')) {
    e.preventDefault();
  }
}

/** 点击候选：冒泡至容器统一复位（父级候选 @click 只管更新选中值） */
function handleContainerClick(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('[data-combobox-candidate]')) {
    reset();
  }
}

function handleBlur(): void {
  setTimeout(() => {
    open.value = false;
  }, 150);
}

// 候选数量变化（异步刷新/本地过滤）时收敛激活索引，避免 ↑↓ 越界
watch(
  () => props.candidateCount,
  (n) => {
    if (activeIndex.value >= n) activeIndex.value = n - 1;
  },
);
</script>

<template>
  <div class="relative" @mousedown="handleContainerMousedown" @click="handleContainerClick">
    <div class="relative">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        :id="props.id"
        role="combobox"
        :aria-expanded="dropdownVisible"
        aria-autocomplete="list"
        :aria-activedescendant="dropdownVisible && activeIndex >= 0 ? optId(activeIndex) : undefined"
        class="pl-8 pr-8"
        :placeholder="props.placeholder"
        :disabled="props.disabled"
        :model-value="searching ? query : props.value"
        @update:model-value="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown="handleKeydown"
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

    <!-- 下拉：loading / error / 候选（插槽） / empty 四态 -->
    <div
      v-if="dropdownVisible"
      class="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <div
        v-if="props.loading"
        class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
      >
        <Loader2 class="h-3.5 w-3.5 animate-spin" /> 加载中…
      </div>
      <p v-else-if="props.error" class="px-3 py-2 text-sm text-red-500">
        {{ props.errorText }}
      </p>
      <slot
        v-else-if="props.candidateCount > 0"
        :active-index="activeIndex"
        :opt-id="optId"
      />
      <p v-else class="px-3 py-2 text-sm text-muted-foreground">{{ props.emptyText }}</p>
    </div>
  </div>
</template>
