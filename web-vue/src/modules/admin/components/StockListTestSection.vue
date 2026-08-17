<script setup lang="ts">
/**
 * modules/admin/components/StockListTestSection.vue — 「证券主数据 + 接口测试」板块
 *
 * 平移自 React 版 features/admin/stock-list-test-section.tsx（主容器），行为契约一致。
 * 左右两栏（lg:grid-cols-2）：
 * - 左 StockListPanel：只读系统级证券主数据 + 关键字搜索 + 分页 + 批量/单行删除。
 * - 右 MasterStatsPanel（本次同步来源 + 主数据按类别分布） + InterfaceTestPanel
 *   （选接口 → 编辑参数 → 执行测试 → 展示原始响应 + 解析结果）。
 *
 * 左右联动：左栏「填入测试」把 code 追加到右栏 codesText。
 */

import { computed, ref } from 'vue';
import { useSyncSecurityMasters } from '../composables/use-security-master';
import type { UsedInterfaceInfo } from '@/api/security-master.api';
import StockListPanel from './StockListPanel.vue';
import MasterStatsPanel from './MasterStatsPanel.vue';
import InterfaceTestPanel from './InterfaceTestPanel.vue';

/** 「本次同步来源」持久化键：组件重挂载后从 localStorage 读取，下次同步成功再覆盖 */
const SYNC_SOURCE_KEY = 'invest:master-sync-source';

function readStoredUsed(): UsedInterfaceInfo[] | null {
  try {
    const raw = localStorage.getItem(SYNC_SOURCE_KEY);
    return raw ? (JSON.parse(raw) as UsedInterfaceInfo[]) : null;
  } catch {
    return null;
  }
}

// 左右联动：左栏「填入测试」追加 code 到右栏 codesText
const codesText = ref('');

// 同步逻辑上提：左栏同步按钮与右侧统计块共享「本次同步来源」
const syncMut = useSyncSecurityMasters();
const lastUsed = ref<UsedInterfaceInfo[] | null>(readStoredUsed());
const usedSources = computed(() =>
  syncMut.data.value?.used && syncMut.data.value.used.length > 0
    ? syncMut.data.value.used
    : lastUsed.value,
);

function handleSync(): void {
  syncMut.mutate(undefined, {
    onSuccess: (data) => {
      if (data.used && data.used.length > 0) {
        lastUsed.value = data.used;
        try {
          localStorage.setItem(SYNC_SOURCE_KEY, JSON.stringify(data.used));
        } catch {
          /* 忽略持久化失败（隐私模式 / 配额） */
        }
      }
    },
  });
}

function pickCode(code: string): void {
  codesText.value = codesText.value ? `${codesText.value},${code}` : code;
}
</script>

<template>
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
    <StockListPanel
      :sync-pending="syncMut.isPending.value"
      @sync="handleSync"
      @pick-code="pickCode"
    />
    <div class="space-y-6">
      <MasterStatsPanel :used-sources="usedSources" />
      <InterfaceTestPanel
        :codes-text="codesText"
        @codes-change="codesText = $event"
      />
    </div>
  </div>
</template>