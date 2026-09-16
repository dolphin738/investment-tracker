<script setup lang="ts">
/**
 * modules/overview/components/OverviewKeyMetricsSection.vue — 区一「关键指标」
 *
 * 纯位置性拆分（S4）：平移自 DashboardPage.vue L464–L496（零行为变更）。
 * 8 指标卡按 group 拆成两个带小标题的分组 ——
 * 「资产构成」4（当前总资产 / 持仓市值 / 现金余额 / 净投入）+「收益表现」4
 * （累计收益率 / 当年收益率 / 年化 XIRR / 累计净值），回答「我有多少 vs 赚了多少」。
 *
 * 分组只是 filter(m => m.group === …) 的展示切分，值与涨跌方向仍由
 * buildOverviewMetrics 统一构造（在 use-dashboard-overview 内），本组件不参与任何计算。
 */

import { Section, SectionTitle } from '@/components/ui/section';
import MetricCard from '@/components/common/MetricCard.vue';
import { METRIC_GRID_CLASS } from '../composables/use-dashboard-overview';
import type { OverviewMetric } from '../features/asset-metrics';

defineProps<{
  /** 资产构成组（当前总资产 / 持仓市值 / 现金余额 / 净投入） */
  assetMetrics: OverviewMetric[];
  /** 收益表现组（累计收益率 / 当年收益率 / 年化 XIRR / 累计净值） */
  returnMetrics: OverviewMetric[];
}>();
</script>

<template>
  <Section title="关键指标" description="资产家底与收益表现一眼看全">
    <!-- 资产构成 4 —— 首张「当前总资产」用极轻描边点题 -->
    <div class="space-y-3">
      <SectionTitle>资产构成</SectionTitle>
      <div :class="METRIC_GRID_CLASS">
        <MetricCard
          v-for="m in assetMetrics"
          :key="m.key"
          :label="m.title"
          :value="m.value"
          :description="m.description"
          :trend="m.trend"
          :class="m.key === 'total-asset' ? 'border-primary/30' : undefined"
        />
      </div>
    </div>

    <!-- 收益表现 4 -->
    <div class="space-y-3">
      <SectionTitle>收益表现</SectionTitle>
      <div :class="METRIC_GRID_CLASS">
        <MetricCard
          v-for="m in returnMetrics"
          :key="m.key"
          :label="m.title"
          :value="m.value"
          :description="m.description"
          :trend="m.trend"
        />
      </div>
    </div>
  </Section>
</template>
