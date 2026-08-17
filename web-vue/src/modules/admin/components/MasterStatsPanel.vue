<script setup lang="ts">
/**
 * modules/admin/components/MasterStatsPanel.vue — 证券主数据统计块
 *
 * 平移自 React 版 features/admin/stock-list-test-section.tsx 的 MasterStatsPanel，行为契约一致。
 * 展示「本次同步来源（接口名 + 每接口获取条数）」与「主数据按类别分布」。
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { computed } from 'vue';
import { securityTypeLabel } from '@/lib/types';
import { useSecurityMasterStats } from '../composables/use-security-master';
import type { UsedInterfaceInfo } from '@/api/security-master.api';

const props = defineProps<{
  usedSources: UsedInterfaceInfo[] | null;
}>();

const { data: stats } = useSecurityMasterStats();
const counts = computed(() => stats.value?.counts ?? {});
const categoryRows = computed(() =>
  Object.entries(counts.value).sort((a, b) => b[1] - a[1]),
);
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">证券主数据统计</CardTitle>
      <CardDescription>本次同步来源与主数据按类别分布</CardDescription>
    </CardHeader>
    <CardContent>
      <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <!-- 左：主数据按类别 -->
        <div>
          <div class="mb-1.5 text-sm font-medium">主数据按类别</div>
          <ul v-if="categoryRows.length > 0" class="space-y-1">
            <li
              v-for="[ac, cnt] in categoryRows"
              :key="ac"
              class="flex items-center justify-between gap-2 border-b border-border/50 py-1 text-sm last:border-0"
            >
              <span class="truncate text-foreground/90">
                {{ securityTypeLabel(ac) }}
              </span>
              <span class="shrink-0 text-muted-foreground">{{ cnt }} 条</span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted-foreground">暂无主数据</p>
        </div>

        <!-- 右：本次同步来源 -->
        <div>
          <div class="mb-1.5 text-sm font-medium">本次同步来源</div>
          <ul
            v-if="props.usedSources && props.usedSources.length > 0"
            class="space-y-1"
          >
            <li
              v-for="u in props.usedSources"
              :key="u.interfaceId"
              class="flex items-center justify-between gap-2 border-b border-border/50 py-1 text-sm last:border-0"
            >
              <span
                class="truncate text-foreground/90"
                :title="`${u.providerName} · ${u.interfaceName}`"
              >
                {{ u.providerName }} · {{ u.interfaceName }}
              </span>
              <span class="shrink-0 text-muted-foreground">
                {{ typeof u.fetched === 'number' ? `${u.fetched} 条` : '—' }}
              </span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted-foreground">暂无同步记录</p>
        </div>
      </div>
    </CardContent>
  </Card>
</template>