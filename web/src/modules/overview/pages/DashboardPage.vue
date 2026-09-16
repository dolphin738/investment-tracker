<script setup lang="ts">
/**
 * modules/overview/pages/DashboardPage.vue — 概览页门面（PRD §7.4）
 *
 * 纯位置性拆分（S4）：原 775 行页面拆为
 *   - composables/use-dashboard-overview.ts（全部状态/查询/computed/URL-state/弹窗状态 + 4 常量 + 动作函数）
 *   - components/OverviewKeyMetricsSection.vue（区一「关键指标」）
 *   - components/OverviewTrendGrid.vue（区二动态体：引导卡 + 四宫格）
 * 本文件只保留：骨架分支 + 页头 + 区二筛选栏/维度 Tabs/日期选择器/hero 图
 * + 装配两个子组件 + 两个录入弹窗。除位置移动与 import/接线外，零行为变更。
 */

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Section } from '@/components/ui/section';
import TotalAssetTrendChart from '../components/TotalAssetTrendChart.vue';
import FreshnessBanner from '../components/FreshnessBanner.vue';
import PriceFreshnessBadge from '@/modules/holdings/components/PriceFreshnessBadge.vue';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import CashflowForm from '@/modules/cashflow/components/CashflowForm.vue';
import SecurityTradeForm from '@/modules/security-trade/components/SecurityTradeForm.vue';
import {
  GRANULARITY_TABS,
  useDashboardOverview,
} from '../composables/use-dashboard-overview';
import OverviewKeyMetricsSection from '../components/OverviewKeyMetricsSection.vue';
import OverviewTrendGrid from '../components/OverviewTrendGrid.vue';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
} from '@/constants/entry-button-labels';
import type { OverviewQueryState } from '../features/overview-query-params';

const {
  portfolios,
  portfoliosLoading,
  currentPortfolioId,
  overviewLoading,
  overviewIsError,
  overviewRefetch,
  latestNavLoading,
  latestNavError,
  latestNavRefetch,
  ov,
  overviewQuery,
  setOverviewQuery,
  markRangeInteracted,
  startDate,
  endDate,
  baseDate,
  navSeriesData,
  navSeriesLoading,
  amountThousands,
  amountAbbrev,
  cashflowOpen,
  tradeOpen,
  assetMetrics,
  returnMetrics,
  hasNoData,
  xirrSeriesData,
  xirrSeriesLoading,
  recentLoading,
  recentItems,
  summaryLoading,
  summaryList,
  xirrDecimals,
  openCashflow,
  openTrade,
} = useDashboardOverview();

/** 区二筛选栏 → DateRangeQuickPicker 变更：标记已交互 + 写回 URL-state */
function onRangeChange(r: {
  /** 起始日期 YYYY-MM-DD */
  startDate: string;
  /** 结束日期 YYYY-MM-DD */
  endDate: string;
  /** 命中的快捷项 value；手动编辑时为 undefined */
  quick?: string;
}): void {
  markRangeInteracted();
  setOverviewQuery(
    r.quick
      ? { range: r.quick as OverviewQueryState['range'], from: '', to: '' }
      : { range: 'custom', from: r.startDate, to: r.endDate },
  );
}
</script>

<template>
  <div class="space-y-8">
    <!-- ===== 加载态：组合列表 ===== -->
    <div v-if="portfoliosLoading" class="space-y-6">
      <PageHeader title="概览" description="加载中…" />
      <Skeleton class="h-40 w-full" />
    </div>

    <!-- ===== 无组合 ===== -->
    <EmptyState
      v-else-if="portfolios.length === 0"
      title="欢迎，先创建您的第一个投资组合"
      description="创建组合后即可开始录入出入金和买卖数据。"
    />

    <!-- ===== 未选组合 ===== -->
    <Card v-else-if="!currentPortfolioId" class="mx-auto max-w-md">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">
        请先在顶部选择一个投资组合
      </CardContent>
    </Card>

    <!-- ===== 双查询同时加载中 ===== -->
    <div v-else-if="overviewLoading && latestNavLoading" class="space-y-6">
      <PageHeader title="概览" description="加载中…" />
      <Card>
        <CardContent class="space-y-3">
          <Skeleton class="h-7 w-40" />
          <Skeleton class="h-24 w-full" />
          <Skeleton class="h-24 w-full" />
        </CardContent>
      </Card>
    </div>

    <!-- ===== 双查询均失败 ===== -->
    <div v-else-if="overviewIsError && latestNavError" class="space-y-6">
      <PageHeader title="概览" />
      <Card>
        <CardContent class="flex flex-col items-center gap-4 py-12">
          <p class="text-sm text-destructive">数据加载失败，请稍后重试</p>
          <Button
            variant="outline"
            @click="() => { overviewRefetch(); latestNavRefetch(); }"
          >
            重新加载
          </Button>
        </CardContent>
      </Card>
    </div>

    <template v-else>
      <!-- ===== 页头 + 新鲜度提示 ===== -->
      <div class="space-y-4">
        <PageHeader
          title="概览"
          :description="
            ov?.latestDate ? `数据截止 ${ov.latestDate}` : '最近 12 个月收益概览'
          "
        >
          <template #actions>
            <div class="flex items-center gap-2">
              <!-- Q3：行情数据新鲜度徽标（与 FreshnessBanner 后端判定提示互补） -->
              <PriceFreshnessBadge :portfolio-id="currentPortfolioId" />
              <Button
                variant="default"
                size="sm"
                @click="cashflowOpen = true"
              >
                <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
                {{ ENTRY_BUTTON_LABELS.cashFlow }}
              </Button>
              <Button
                variant="default"
                size="sm"
                @click="tradeOpen = true"
              >
                <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
                {{ ENTRY_BUTTON_LABELS.securityTrade }}
              </Button>
            </div>
          </template>
        </PageHeader>

        <!-- 数据新鲜度提示条（DASH-P1-03 · 后端判定，isStale=false 不渲染） -->
        <FreshnessBanner
          v-if="ov?.freshness"
          :portfolio-id="currentPortfolioId"
          :freshness="ov.freshness"
        />
      </div>

      <!-- ===== 区一「关键指标」：8 卡按 group 分两组 ===== -->
      <OverviewKeyMetricsSection
        :asset-metrics="assetMetrics"
        :return-metrics="returnMetrics"
      />

      <!-- ===== 区二「趋势分析」：筛选栏 → hero 走势图 → 四宫格 ===== -->
      <Section title="趋势分析" description="维度与区间对本区所有图表统一生效">
        <!--
          维度切换 + 范围筛选（共享 DateRangeQuickPicker，受控回显 URL range）。
          移动端纵向堆叠，>=640px 回到一行，与其他分析页一致。
        -->
        <div class="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Tabs
            :model-value="overviewQuery.g"
            class="w-auto"
            @update:model-value="
              (v) => setOverviewQuery({ g: v as OverviewQueryState['g'] })
            "
          >
            <TabsList>
              <TabsTrigger
                v-for="tab in GRANULARITY_TABS"
                :key="tab.value"
                :value="tab.value"
              >
                {{ tab.label }}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <DateRangeQuickPicker
            :quick="overviewQuery.range === 'custom' ? undefined : overviewQuery.range"
            :start-date="startDate"
            :end-date="endDate"
            :all-range-start="baseDate"
            @change="onRangeChange"
          />
        </div>

        <!-- hero 图：总资产走势（含手工记录标记） -->
        <TotalAssetTrendChart
          :data="navSeriesData ?? []"
          :loading="navSeriesLoading"
          :portfolio-id="currentPortfolioId"
          :start-date="startDate"
          :end-date="endDate"
          :amount-thousands="amountThousands"
          :amount-abbrev="amountAbbrev"
        />

        <!-- 区二动态体：引导卡 + 四宫格 -->
        <OverviewTrendGrid
          :has-no-data="hasNoData"
          :nav-series-data="navSeriesData ?? []"
          :nav-series-loading="navSeriesLoading"
          :xirr-series-data="xirrSeriesData ?? []"
          :xirr-series-loading="xirrSeriesLoading"
          :recent-loading="recentLoading"
          :recent-items="recentItems"
          :amount-thousands="amountThousands"
          :amount-abbrev="amountAbbrev"
          :summary-loading="summaryLoading"
          :summary-list="summaryList"
          :xirr-decimals="xirrDecimals"
          :open-cashflow="openCashflow"
          :open-trade="openTrade"
        />
      </Section>

      <!-- 录入出入金弹窗 -->
      <Dialog
        :open="cashflowOpen"
        @update:open="(v: boolean) => (cashflowOpen = v)"
      >
        <DialogContent class="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{{ ENTRY_BUTTON_LABELS.cashFlow }}</DialogTitle>
          </DialogHeader>
          <CashflowForm
            :portfolio-id="currentPortfolioId"
            :on-success="() => (cashflowOpen = false)"
          />
        </DialogContent>
      </Dialog>

      <!-- 录入买卖弹窗 -->
      <Dialog
        :open="tradeOpen"
        @update:open="(v: boolean) => (tradeOpen = v)"
      >
        <DialogContent class="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{{ ENTRY_BUTTON_LABELS.securityTrade }}</DialogTitle>
          </DialogHeader>
          <!-- SecurityTradeForm：录入买卖流水并维护现价（对齐 React dashboard 用法，
                success → 关闭弹窗；持仓、净值与收益自动推导） -->
          <SecurityTradeForm
            :portfolio-id="currentPortfolioId"
            @success="tradeOpen = false"
          />
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
