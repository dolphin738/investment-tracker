<script setup lang="ts">
/**
 * modules/account/components/AssetOverviewCard.vue — 资产全景卡（只读 · ACC-P0-03）
 *
 * 对齐 React 版 web/src/pages/AccountPage.tsx「资产全景」卡：
 * - 组合数 / 合计总资产 / 合计净投入 / 合计浮动盈亏（null → 「—」，SYS-P0-05 四态）
 * - 仅做金额类求和（Q-07：不做跨组合合计 XIRR / 合计净值）
 * - 无总资产记录（totalAsset 为 0 且无更新日）的组合不参与合计，提示条数
 * - 数据源 GET /portfolios/summary（staleTime 60s，布局层组合选择器已消费同 key）
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getPortfoliosSummary } from '@/api/overview.api';
import { formatCurrency } from '@/lib/utils';
import { usePreferenceStore } from '@/stores/preference.store';

/** 无数据统一占位符（SYS-P0-05：null 是「无数据」不是 0） */
const NO_DATA = '—';

const preferenceStore = usePreferenceStore();
const amountThousands = computed(() => preferenceStore.getPreference('amountThousands'));
const amountAbbrev = computed(() => preferenceStore.getPreference('amountAbbrev'));

const summary = useQuery({
  queryKey: ['portfolios', 'summary'],
  queryFn: () => getPortfoliosSummary(),
  staleTime: 60 * 1000,
});

/** 合计总资产：仅金额类求和（Q-07 豁免） */
const totalAsset = computed(() => {
  const data = summary.data.value;
  if (!data) return 0;
  return data.reduce(
    (sum, p) => sum + (Number.parseFloat(p.totalAsset || '0') || 0),
    0,
  );
});

/** 合计净投入：Σ netInvested（必填；无出入金为 '0.00'） */
const totalNetInvested = computed(() => {
  const data = summary.data.value;
  if (!data) return 0;
  return data.reduce(
    (sum, p) => sum + (Number.parseFloat(p.netInvested || '0') || 0),
    0,
  );
});

/**
 * 合计浮动盈亏：Σ floatingProfit，跳过 null —— 无快照的组合不参与合计，
 * 避免把「无数据」当 0 拉低合计；全部无快照时返回 null → 渲染「—」。
 */
const totalFloatingProfit = computed<number | null>(() => {
  const data = summary.data.value;
  if (!data) return null;
  let sum = 0;
  let hasAny = false;
  for (const p of data) {
    if (p.floatingProfit != null) {
      sum += Number.parseFloat(p.floatingProfit) || 0;
      hasAny = true;
    }
  }
  return hasAny ? sum : null;
});

/** 无总资产记录的组合数：金额为 0 且无更新日（避免把真实 0 资产误判） */
const missingAssetCount = computed(() => {
  const data = summary.data.value;
  if (!data) return 0;
  return data.filter(
    (p) => !(Number.parseFloat(p.totalAsset || '0') > 0) && !p.lastUpdatedAt,
  ).length;
});
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">资产全景</CardTitle>
    </CardHeader>
    <CardContent>
      <!-- 加载骨架 -->
      <div v-if="summary.isLoading.value" class="grid grid-cols-2 gap-4">
        <div v-for="i in 4" :key="i" class="space-y-2">
          <div class="h-3 w-16 animate-pulse rounded bg-muted" />
          <div class="h-6 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div v-else-if="summary.data.value && summary.data.value.length > 0">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-muted-foreground">组合数</p>
            <p class="text-xl font-bold tabular-nums">
              {{ summary.data.value.length }}
            </p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">合计总资产</p>
            <p class="text-xl font-bold tabular-nums">
              {{ formatCurrency(totalAsset, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">合计净投入</p>
            <p class="text-xl font-bold tabular-nums">
              {{ formatCurrency(totalNetInvested, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">合计浮动盈亏</p>
            <p class="text-xl font-bold tabular-nums">
              {{ totalFloatingProfit != null
                ? formatCurrency(totalFloatingProfit, 2, { thousands: amountThousands, abbreviate: amountAbbrev })
                : NO_DATA }}
            </p>
          </div>
        </div>
        <div class="mt-4 space-y-1 text-xs text-muted-foreground">
          <p v-if="missingAssetCount > 0">
            ⓘ {{ missingAssetCount }} 个组合暂无总资产记录，未计入合计
          </p>
          <p>ⓘ 仅做金额类求和；不做跨组合合计 XIRR / 合计净值（Q-07）</p>
        </div>
      </div>
      <p v-else class="py-4 text-center text-sm text-muted-foreground">
        暂无组合数据
      </p>
    </CardContent>
  </Card>
</template>
