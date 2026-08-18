<script setup lang="ts">
/**
 * modules/portfolio/components/PortfolioSelector.vue — 组合切换下拉
 *
 * 平移自 React 版 web/src/features/portfolio/portfolio-selector.tsx。
 * 顶部导航栏使用，可切换当前组合；内置「新建组合」内联入口。
 * 归档组合从选择器隐藏（SET-P1-04）：仅保留未归档组合可选。
 */

import { computed } from 'vue';
import { Check, ChevronsUpDown, Plus } from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePortfolios } from '../composables/use-portfolios';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { ENTRY_BUTTON_LABELS } from '@/constants/entry-button-labels';

const props = defineProps<{
  /** 选择「创建新组合」时的回调 */
  onCreateClick?: () => void;
  class?: string;
}>();

const { data: portfoliosData, isLoading } = usePortfolios();
const portfolios = computed(() => portfoliosData.value ?? []);
const portfolioStore = usePortfolioStore();

/** 归档组合从选择器隐藏：仅保留未归档组合可选 */
const visiblePortfolios = computed(() =>
  portfolios.value.filter((p) => !p.archivedAt),
);

/** 下拉禁用条件：加载中且尚无任何组合（对齐 React 版 disabled 口径） */
const disabled = computed(() => isLoading.value && portfolios.value.length === 0);

/** 选中值：未选组合时为 undefined（显示占位「选择组合」） */
const selectedValue = computed(() =>
  portfolioStore.currentPortfolioId ?? undefined,
);

function handleValueChange(value: string): void {
  if (value === '__create_new__') {
    props.onCreateClick?.();
    return;
  }
  portfolioStore.setCurrentPortfolio(value);
}
</script>

<template>
  <div :class="props.class">
    <Select
      :model-value="selectedValue"
      :disabled="disabled"
      @update:model-value="handleValueChange"
    >
      <SelectTrigger class="w-[220px]">
        <div class="flex items-center gap-2">
          <ChevronsUpDown class="h-3.5 w-3.5 opacity-50" />
          <SelectValue :placeholder="isLoading ? '加载中…' : '选择组合'" />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>我的组合</SelectLabel>
          <SelectItem
            v-for="p in visiblePortfolios"
            :key="p.id"
            :value="p.id"
          >
            <span class="flex items-center gap-2">
              <Check
                v-if="p.id === portfolioStore.currentPortfolioId"
                class="h-3 w-3"
              />
              {{ p.name }}
            </span>
          </SelectItem>
          <div
            v-if="visiblePortfolios.length === 0"
            class="px-2 py-1.5 text-xs text-muted-foreground"
          >
            暂无组合，请新建
          </div>
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="__create_new__">
          <span class="flex items-center gap-2 text-primary">
            <Plus class="h-3 w-3" />
            <!-- 决策 H：文案取统一字典（下拉内联入口，样式保持内联规格） -->
            {{ ENTRY_BUTTON_LABELS.portfolio }}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>
