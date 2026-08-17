<script setup lang="ts">
/**
 * modules/overview/components/FreshnessBanner.vue — 数据新鲜度提示条
 *
 * 平移自 React 版 web/src/features/overview/freshness-banner.tsx
 * （T03 · DASH-P1-03 / AL-015）。
 *
 * - freshness.isStale === true 时渲染 warning banner；否则不渲染（不占位、无布局跳动）。
 * - 文案列出后端已本地化的全部 reasons（如「行情已 4 天未更新」）。
 * - 操作按钮按 reason.kind 出现：
 *   - PRICE → 「去更新行情」（跳 /holdings）
 *   - CASH  → 「去更新现金余额」（跳 /cashflows）
 *   - 「本次会话不再提示」→ sessionStorage（O-7 默认），关闭本次会话内不再提示。
 *
 * 判定只在后端完成（阈值 / 滞后天数 / 文案），本组件只渲染。
 */

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { AlertTriangle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { FreshnessInfo } from '@/lib/types';

/** sessionStorage key（会话级，O-7 默认），按组合隔离 */
function dismissKey(portfolioId: string): string {
  return `freshness_dismissed_${portfolioId}`;
}

const props = defineProps<{
  portfolioId: string;
  freshness: FreshnessInfo;
}>();

const router = useRouter();

const dismissed = ref(false);
try {
  dismissed.value = sessionStorage.getItem(dismissKey(props.portfolioId)) === '1';
} catch {
  dismissed.value = false;
}

/**
 * 空组合（未录入任何行情与现金余额记录）：latestPriceAsOf / latestCashAsOf 均为 null，
 * 此时仅产生「无现金余额记录」类噪声提示且无任何有效操作入口，按「无数据」隐藏（需求项7）。
 */
const isEmptyPortfolio = computed(
  () =>
    props.freshness.latestPriceAsOf === null &&
    props.freshness.latestCashAsOf === null,
);

const hasPriceReason = computed(() =>
  props.freshness.reasons.some((r) => r.kind === 'PRICE'),
);
const hasCashReason = computed(() =>
  props.freshness.reasons.some((r) => r.kind === 'CASH'),
);

/** 是否渲染（isStale=false / 已关闭 / 空组合 → 均不渲染） */
const visible = computed(
  () => props.freshness.isStale && !dismissed.value && !isEmptyPortfolio.value,
);

function dismissForSession(): void {
  try {
    sessionStorage.setItem(dismissKey(props.portfolioId), '1');
  } catch {
    // 隐私模式等 sessionStorage 不可用场景：仅本次渲染收起，不阻断
  }
  dismissed.value = true;
}
</script>

<template>
  <div
    v-if="visible"
    class="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
  >
    <AlertTriangle class="h-4 w-4 shrink-0" />
    <span class="min-w-0 flex-1">
      {{
        props.freshness.reasons.length > 0
          ? props.freshness.reasons.map((r) => r.label).join('；')
          : '部分数据已超过预设的更新阈值'
      }}
    </span>
    <div class="flex flex-wrap gap-1.5">
      <Button
        v-if="hasPriceReason"
        size="sm"
        variant="outline"
        class="h-6 px-2 text-xs"
        @click="router.push('/holdings')"
      >
        去更新行情
      </Button>
      <Button
        v-if="hasCashReason"
        size="sm"
        variant="outline"
        class="h-6 px-2 text-xs"
        @click="router.push('/cashflows')"
      >
        去更新现金余额
      </Button>
      <Button
        size="sm"
        variant="ghost"
        class="h-6 px-2 text-xs"
        @click="dismissForSession"
      >
        本次会话不再提示
      </Button>
    </div>
  </div>
</template>
