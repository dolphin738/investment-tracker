<script setup lang="ts">
/**
 * modules/overview/components/OverviewTrendGrid.vue — 区二动态体（引导卡 + 四宫格）
 *
 * 纯位置性拆分（S4）：平移自 DashboardPage.vue L551–L737（零行为变更）。
 * 区二「趋势分析」筛选栏（维度 Tabs / DateRangeQuickPicker / hero 图）保留在门面
 * （它们直接消费 URL-state / range 同步），本组件只承接其下方的数据动态体：
 *
 *   - 有组合但无数据：渲染三步引导卡（DASH-P0-06）
 *   - 否则：四宫格（净值趋势 / XIRR 趋势 / 近期出入金 / 组合表现对比）
 *
 * 两个打开录入弹窗的入口改为回调（openCashflow / openTrade），由门面从
 * use-dashboard-overview 注入，避免在子组件内直接依赖弹窗状态。
 */

import { RouterLink } from 'vue-router';
import { ArrowUpFromLine, ArrowLeftRight, Plus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import NavTrendChart from '@/components/charts/NavTrendChart.vue';
import XirrTrendChart from '@/components/charts/XirrTrendChart.vue';
import { ROUTE_PATH } from '@/lib/constants';
import { CashFlowType } from '@/lib/types';
import { formatPercent, formatCurrency, formatDate, cn } from '@/lib/utils';
import type { NavSeriesPoint, XirrSeriesPoint } from '@/lib/types';
import type { TransactionResponse, PortfolioSummary } from '@/api/types';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
} from '@/constants/entry-button-labels';
import {
  TYPE_LABEL,
  ONBOARDING_STEPS,
} from '../composables/use-dashboard-overview';

const props = withDefaults(
  defineProps<{
    /** 「有组合但无数据」判定（DASH-P0-06） */
    hasNoData: boolean;
    /** 净值序列（累计 + 当年双线） */
    navSeriesData: NavSeriesPoint[];
    /** 净值序列加载态 */
    navSeriesLoading: boolean;
    /** XIRR 序列 */
    xirrSeriesData: XirrSeriesPoint[];
    /** XIRR 序列加载态 */
    xirrSeriesLoading: boolean;
    /** 近期出入金加载态 */
    recentLoading: boolean;
    /** 近期出入金列表（最新 5 笔） */
    recentItems: TransactionResponse[];
    /** 金额千分位偏好 */
    amountThousands: boolean;
    /** 金额万/亿缩写偏好 */
    amountAbbrev: boolean;
    /** 组合摘要加载态 */
    summaryLoading: boolean;
    /** 组合摘要列表 */
    summaryList: PortfolioSummary[];
    /** 比率小数位（XIRR / 收益率）偏好 */
    xirrDecimals: number;
    /** 打开录入出入金弹窗回调 */
    openCashflow: () => void;
    /** 打开录入买卖弹窗回调 */
    openTrade: () => void;
  }>(),
  {
    navSeriesData: () => [],
    xirrSeriesData: () => [],
    recentItems: () => [],
    summaryList: () => [],
  },
);
</script>

<template>
  <!-- 有组合但无数据：三步引导（DASH-P0-06） -->
  <Card v-if="hasNoData">
    <CardHeader>
      <CardTitle class="text-base">开始记录你的投资</CardTitle>
      <p class="text-sm text-muted-foreground">
        当前组合还没有任何数据，按下面三步录入即可看到净值、XIRR 与持仓分析。
      </p>
    </CardHeader>
    <CardContent>
      <ol class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <li
          v-for="step in ONBOARDING_STEPS"
          :key="step.index"
          class="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4"
        >
          <div class="flex items-center gap-2">
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              {{ step.index }}
            </span>
            <span class="text-sm font-medium">{{ step.title }}</span>
          </div>
          <p class="text-xs leading-relaxed text-muted-foreground">
            {{ step.description }}
          </p>
          <!-- INC-05：引导卡按钮与页头主入口同规格（主色 + sm + Plus） -->
          <Button
            v-if="step.actionLabel"
            size="sm"
            variant="default"
            class="mt-auto self-start"
            @click="step.action === 'trade' ? openTrade() : openCashflow()"
          >
            <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
            {{ step.actionLabel }}
          </Button>
        </li>
      </ol>
    </CardContent>
  </Card>

  <!-- 四宫格（仅在有数据时渲染） -->
  <div v-if="!hasNoData" class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <NavTrendChart
      :data="navSeriesData"
      :loading="navSeriesLoading"
      title="净值趋势（累计 + 当年）"
    />
    <XirrTrendChart
      :data="xirrSeriesData"
      :loading="xirrSeriesLoading"
      title="XIRR 趋势"
      :connect-nulls="false"
    />

    <!-- 近期出入金（最近5笔） -->
    <Card>
      <CardHeader class="flex flex-row items-center justify-between">
        <CardTitle class="text-base">近期出入金</CardTitle>
        <!-- DASH-P0-05：跳转出入金页查看完整流水 -->
        <div class="flex items-center gap-3">
          <RouterLink
            :to="ROUTE_PATH.TRANSACTIONS"
            class="text-xs text-muted-foreground hover:underline"
          >
            查看全部
          </RouterLink>
          <ArrowLeftRight class="h-4 w-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        <TableSkeleton v-if="recentLoading" :rows="3" :cols="3" />
        <div v-else-if="recentItems.length > 0" class="space-y-3">
          <div
            v-for="tx in recentItems"
            :key="tx.id"
            class="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0"
          >
            <div class="flex items-center gap-3">
              <span class="text-sm text-muted-foreground">
                {{ formatDate(tx.date, 'MM-dd') }}
              </span>
              <span
                :class="cn(
                  'text-xs font-medium',
                  tx.type === CashFlowType.BUY
                    ? 'text-up'
                    : 'text-down',
                )"
              >
                {{ TYPE_LABEL[tx.type] || tx.type }}
              </span>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-sm font-medium tabular-nums">
                {{
                  (tx.type === CashFlowType.BUY ? '+' : '-') +
                    formatCurrency(tx.amount, 2, {
                      thousands: amountThousands,
                      abbreviate: amountAbbrev,
                    })
                }}
              </span>
              <span
                v-if="tx.note"
                class="max-w-[120px] truncate text-xs text-muted-foreground"
              >
                {{ tx.note }}
              </span>
            </div>
          </div>
        </div>
        <EmptyState
          v-else
          title="还没有出入金记录"
          description="录入第一笔出入金开始跟踪收益"
        >
          <template #action>
            <Button
              variant="default"
              size="sm"
              @click="openCashflow()"
            >
              <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
              {{ ENTRY_BUTTON_LABELS.cashFlow }}
            </Button>
          </template>
        </EmptyState>
      </CardContent>
    </Card>

    <!-- 组合表现对比 -->
    <Card>
      <CardHeader class="flex flex-row items-center justify-between">
        <CardTitle class="text-base">组合表现对比</CardTitle>
        <ArrowUpFromLine class="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <TableSkeleton v-if="summaryLoading" :rows="3" :cols="4" />
        <div v-else-if="summaryList.length > 0" class="space-y-2">
          <div
            v-for="p in summaryList"
            :key="p.id"
            class="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
          >
            <span class="font-medium">{{ p.name }}</span>
            <div class="flex items-center gap-4">
              <span class="tabular-nums">
                {{
                  formatCurrency(p.totalAsset, 2, {
                    thousands: amountThousands,
                    abbreviate: amountAbbrev,
                  })
                }}
              </span>
              <!-- 用 != null 同时排除 null 与 undefined：
                   后端已返回该字段但仍可能为 null（尚无 DailyNav），
                   旧写法 !== null 会放行 undefined 并渲染出 NaN%。 -->
              <span
                v-if="p.cumulativeReturnRate != null"
                :class="cn(
                  'tabular-nums',
                  Number(p.cumulativeReturnRate) >= 0
                    ? 'text-up'
                    : 'text-down',
                )"
              >
                {{
                  formatPercent(p.cumulativeReturnRate, 2, {
                    decimals: xirrDecimals,
                  })
                }}
              </span>
              <span v-if="p.xirr != null" class="text-xs text-muted-foreground">
                XIRR
                {{ formatPercent(p.xirr, 2, { decimals: xirrDecimals }) }}
              </span>
            </div>
          </div>
        </div>
        <div v-else class="py-10 text-center text-sm text-muted-foreground">
          暂无组合数据
        </div>
      </CardContent>
    </Card>
  </div>
</template>
