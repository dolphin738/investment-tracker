<script setup lang="ts">
/**
 * modules/security-price/components/SyncPricesButton.vue — 行情同步按钮
 *
 * 触发组合行情同步（路径 C：POST /portfolios/{id}/prices/sync，同步等待）。
 * - 进行中：按钮禁用 + 图标旋转 + 文本「同步中」（进度提示）
 * - 成功：toast 成功（含部分失败条目的失败提示，见 useSyncPortfolioPrices）
 * - 失败：toast 失败提示
 * 无组合（portfolioId 为 null）时按钮禁用。
 */
import { computed } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { useSyncPortfolioPrices } from '../composables/use-security-prices';

const props = defineProps<{
  /** 组合 id（null 时禁用，不做任何请求） */
  portfolioId: string | null;
}>();

const syncMutation = useSyncPortfolioPrices();

const disabled = computed(
  () => !props.portfolioId || syncMutation.isPending.value,
);

function handleSync(): void {
  if (props.portfolioId) {
    syncMutation.mutate({ portfolioId: props.portfolioId });
  }
}
</script>

<template>
  <Button
    type="button"
    variant="outline"
    size="sm"
    :disabled="disabled"
    :aria-busy="syncMutation.isPending.value"
    @click="handleSync"
  >
    <RefreshCw
      :class="[
        'h-3.5 w-3.5',
        syncMutation.isPending.value ? 'animate-spin' : '',
      ]"
    />
    {{ syncMutation.isPending.value ? '同步中' : '同步行情' }}
  </Button>
</template>