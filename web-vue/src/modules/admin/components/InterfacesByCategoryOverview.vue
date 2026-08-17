<script setup lang="ts">
/**
 * modules/admin/components/InterfacesByCategoryOverview.vue — 顶层「按分类汇总所有提供方接口」总览
 *
 * 平移自 React 版 features/admin/quote-provider-section.tsx 的 InterfacesByCategoryOverview。
 * 跨提供方按接口分类聚合；未分类时显示「未分类」；已分类分组可拖拽手柄调整优先级顺序。
 */

import { computed } from 'vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { QuoteInterface } from '@/api/quote-interface.api';
import type { QuoteProvider } from '@/api/quote-provider.api';
import { useInterfaceCategories } from '../composables/use-interface-category';
import { useQuoteInterfacesAll } from '../composables/use-quote-interface';
import { useQuoteProviders } from '../composables/use-quote-provider';
import OverviewCategoryGroup from './OverviewCategoryGroup.vue';

const { data: interfaces, isLoading } = useQuoteInterfacesAll();
const { data: categories } = useInterfaceCategories();
const { data: providers } = useQuoteProviders();

/** 分类 key → 展示名（无匹配显示 raw key） */
const labelMap = computed(() => {
  const m = new Map<string, string>();
  (categories.value ?? []).forEach((c) => m.set(c.id, c.label));
  return m;
});

/** 提供方 id → 提供方（查名称用） */
const providerById = computed(() => {
  const m = new Map<string, QuoteProvider>();
  (providers.value ?? []).forEach((p) => m.set(p.id, p));
  return m;
});

/** 全部接口按 category_id 分组 */
const groups = computed(() => {
  const map = new Map<string | null, QuoteInterface[]>();
  (interfaces.value ?? []).forEach((it) => {
    const k = it.category_id;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  });
  return Array.from(map.entries());
});

function groupLabel(type: string | null): string {
  return type ? (labelMap.value.get(type) ?? type) : '未分类';
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">按分类汇总所有提供方接口</CardTitle>
      <CardDescription>
        跨提供方按接口分类聚合；未分类时显示「未分类」；已分类分组可拖拽手柄调整优先级顺序
      </CardDescription>
    </CardHeader>
    <CardContent>
      <p v-if="isLoading" class="py-8 text-center text-sm text-muted-foreground">
        加载中…
      </p>
      <p v-else-if="!isLoading && groups.length === 0" class="py-8 text-center text-sm text-muted-foreground">
        暂无接口
      </p>
      <OverviewCategoryGroup
        v-for="[type, items] in groups"
        :key="type ?? 'uncategorized'"
        :category-id="type"
        :label="groupLabel(type)"
        :items="items"
        :provider-by-id="providerById"
      />
    </CardContent>
  </Card>
</template>