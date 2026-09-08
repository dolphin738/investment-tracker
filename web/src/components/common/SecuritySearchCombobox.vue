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
 * 2026-09-09 交互骨架下沉至通用 ComboboxShell（审查 M-1 / 债务收口），本组件保留
 * 远程搜索数据层（防抖 + useQuery）；顺带获得键盘导航与 ARIA（L-1）与错误态
 * （L-2）。对外 props/emits 契约不变（DividendForm / SecurityTradeForm /
 * HoldingsToolbar 零改动）。
 */
import { computed, ref, watch } from 'vue';
import { onUnmounted } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import ComboboxShell from '@/components/common/ComboboxShell.vue';
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

// 选中/清空统一经 emit 触发（2026-09-09 审查收口：DividendForm 绑定已从
// :on-select/:on-clear 迁移为 @select/@clear，全调用方统一 emit 单路径——
// 实测 :on-select（kebab key）不在 emit('select') 命中范围，且原版
// 「props 回调 + emit」在 camel 绑定下会双触发）
const emit = defineEmits<{
  select: [master: SecurityMaster];
  clear: [];
}>();

const SEARCH_DEBOUNCE_MS = 250;

const rawQuery = ref('');
const debouncedQ = ref('');

// 防抖：键入 250ms 后触发搜索
watch(rawQuery, (val) => {
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

const { data, isFetching, isError } = useQuery({
  queryKey: computed(() => ['security-master', 'search', debouncedQ.value]),
  queryFn: () => listSecurityMasters({ q: debouncedQ.value, pageSize: 20 }),
  enabled: computed(() => debouncedQ.value.length > 0),
  staleTime: 30 * 1000,
});

const candidates = computed(() => data.value?.items ?? []);

function handlePick(master: SecurityMaster): void {
  // 统一经 emit 触发：@select（HoldingsToolbar/SecurityTradeForm）与 :on-select
  // （DividendForm）绑定均落在同一 onSelect 槽位监听器，emit 单次调用即全覆盖
  // （实测 emit('clear') 会调用 props.onClear 槽位——原版「props 回调 + emit」双触发是潜在 bug，一并修正）。
  emit('select', master);
}

// 模板内使用 window / setTimeout 会在模板作用域解析为组件实例属性，故抽为具名函数
function handleClear(): void {
  rawQuery.value = '';
  debouncedQ.value = '';
  emit('clear');
}
</script>

<template>
  <ComboboxShell
    :value="props.value"
    :placeholder="props.placeholder"
    :id="props.id"
    :disabled="props.disabled"
    :loading="isFetching"
    :error="isError"
    :candidate-count="candidates.length"
    @search="(v: string) => (rawQuery = v)"
    @select-index="(i: number) => handlePick(candidates[i])"
    @clear="handleClear"
  >
    <template #default="{ activeIndex, optId }">
      <button
        v-for="(s, i) in candidates"
        :key="s.id"
        type="button"
        data-combobox-candidate
        :id="optId(i)"
        role="option"
        :aria-selected="i === activeIndex"
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
  </ComboboxShell>
</template>
