<script setup lang="ts">
/**
 * modules/account/components/StatsOverviewCard.vue — 数据统计卡（只读 · ACC-P0-06）
 *
 * 对齐 React 版 web/src/pages/AccountPage.tsx「数据统计」卡：
 * - StatTile 网格：出入金笔数 / 证券买卖笔数 / 总资产记录天数 / 账户使用天数，
 *   起始日期 / 最近日期（后端有值才渲染）
 * - 数据源 GET /account/stats（staleTime 60s）
 */
import { useQuery } from '@tanstack/vue-query';
import {
  ArrowRightLeft,
  Calendar,
  CalendarRange,
  Clock,
  LineChart,
} from 'lucide-vue-next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAccountStats } from '@/api/account.api';
import { formatDate } from '@/lib/utils';

const stats = useQuery({
  queryKey: ['account', 'stats'],
  queryFn: () => getAccountStats(),
  staleTime: 60 * 1000,
});
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">数据统计</CardTitle>
    </CardHeader>
    <CardContent>
      <!-- 加载骨架 -->
      <div v-if="stats.isLoading.value" class="grid grid-cols-2 gap-4">
        <div v-for="i in 4" :key="i" class="space-y-2">
          <div class="h-3 w-16 animate-pulse rounded bg-muted" />
          <div class="h-6 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div v-else-if="stats.data.value" class="grid grid-cols-2 gap-4">
        <!-- 出入金笔数（CashFlow 计数） -->
        <div class="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <ArrowRightLeft class="h-5 w-5 text-muted-foreground" />
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">出入金笔数</p>
            <p class="truncate text-lg font-bold tabular-nums">
              {{ stats.data.value.cashflowCount }}
            </p>
          </div>
        </div>
        <!-- 证券买卖笔数（SecurityTrade 计数） -->
        <div class="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <LineChart class="h-5 w-5 text-muted-foreground" />
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">证券买卖笔数</p>
            <p class="truncate text-lg font-bold tabular-nums">
              {{ stats.data.value.tradeCount }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <CalendarRange class="h-5 w-5 text-muted-foreground" />
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">总资产记录天数</p>
            <p class="truncate text-lg font-bold tabular-nums">
              {{ stats.data.value.snapshotDays }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <Clock class="h-5 w-5 text-muted-foreground" />
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">账户使用天数</p>
            <p class="truncate text-lg font-bold tabular-nums">
              {{ stats.data.value.recordDays }}
            </p>
          </div>
        </div>
        <div
          v-if="stats.data.value.firstDate"
          class="flex items-center gap-3 rounded-lg bg-muted/40 p-3"
        >
          <Calendar class="h-5 w-5 text-muted-foreground" />
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">起始日期</p>
            <p class="truncate text-lg font-bold tabular-nums">
              {{ formatDate(stats.data.value.firstDate) }}
            </p>
          </div>
        </div>
        <div
          v-if="stats.data.value.lastDate"
          class="flex items-center gap-3 rounded-lg bg-muted/40 p-3"
        >
          <Calendar class="h-5 w-5 text-muted-foreground" />
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">最近日期</p>
            <p class="truncate text-lg font-bold tabular-nums">
              {{ formatDate(stats.data.value.lastDate) }}
            </p>
          </div>
        </div>
      </div>
      <p v-else class="py-4 text-center text-sm text-muted-foreground">
        暂无统计数据
      </p>
    </CardContent>
  </Card>
</template>
