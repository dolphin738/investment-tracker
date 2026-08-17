<script setup lang="ts">
/**
 * modules/holdings/components/PriceFreshnessBadge.vue — 行情数据新鲜度徽标（Q3）
 *
 * 平移自 React 版 web/src/features/portfolio/price-freshness-badge.tsx。
 *
 * 依据后端 GET /portfolios/{id}/prices/sync-status 的最新 fetched_at 判断：
 * - 无数据（last_fetched_at 为 null）或距现在超过 STALE_HOURS(=8) → 红色圆点（数据缺失/陈旧）；
 * - 否则 → 绿色圆点 + 「数据截至 HH:MM · 来源」。
 *
 * 时间统一按北京时间（UTC+8）展示，与 lib/constants.nowInAppTzIso 同一不变式。
 * 组件自身消费 usePriceSyncStatus（按 portfolioId 轮询），调用方只需传入组合 id。
 */
import { computed, toValue } from 'vue';
import { usePriceSyncStatus } from '../composables/use-price-sync-status';
import {
  STALE_HOURS,
  formatTimeInAppTz,
  isPriceDataStale,
} from '../price-freshness';

const props = defineProps<{
  /** 组合 id（null / 空时不发起请求，展示「暂无行情数据」） */
  portfolioId: string | null;
}>();

const { data } = usePriceSyncStatus(computed(() => toValue(props.portfolioId)));

const lastFetchedAt = computed(() => data.value?.last_fetched_at ?? null);
const source = computed(() => data.value?.source ?? null);
const stale = computed(() => isPriceDataStale(lastFetchedAt.value));
</script>

<template>
  <span
    v-if="stale"
    class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
  >
    <span class="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
    {{
      lastFetchedAt
        ? `行情数据已超 ${STALE_HOURS} 小时未更新`
        : '暂无行情数据'
    }}
  </span>
  <span
    v-else
    class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
  >
    <span class="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
    数据截至 {{ formatTimeInAppTz(lastFetchedAt as string) }} · {{ source ?? '-' }}
  </span>
</template>
