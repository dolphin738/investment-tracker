<script setup lang="ts">
/**
 * modules/admin/components/InterfaceEnabledSwitch.vue — 接口级内联开关
 *
 * 平移自 React 版 features/admin/quote-provider-section.tsx 的 InterfaceEnabledSwitch。
 * 直接调用接口更新 mutation 即时切换该接口的 enabled。
 * providerEnabled 为 false（父级总闸已停用）时，开关置灰并提示「父级已停用」，
 * 避免「开了接口却没数据」的困惑。该提示仅影响 UI，不改变选源语义
 * （选源仍由后端 provider.enabled AND interface.enabled 共同决定）。
 */

import { computed } from 'vue';
import { Switch } from '@/components/ui/switch';
import type { QuoteInterface } from '@/api/quote-interface.api';
import { useUpdateInterface } from '../composables/use-quote-interface';

const props = defineProps<{
  item: QuoteInterface;
  providerEnabled: boolean;
}>();

const upd = useUpdateInterface();

const disabled = computed(() => !props.providerEnabled || upd.isPending.value);

function handleChange(v: boolean): void {
  if (v === props.item.enabled) return;
  upd.mutate({ id: props.item.id, body: { enabled: v } });
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <Switch
      :model-value="props.item.enabled"
      :disabled="disabled"
      :aria-label="props.item.enabled ? '停用接口' : '启用接口'"
      @update:model-value="handleChange"
    />
    <span v-if="!props.providerEnabled" class="text-xs text-muted-foreground">
      父级已停用
    </span>
  </div>
</template>