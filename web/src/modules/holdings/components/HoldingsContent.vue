<script setup lang="ts">
/**
 * modules/holdings/components/HoldingsContent.vue — 持仓 Tab 内容（平移自 HoldingsPage.vue）
 *
 * 纯位置拆分：持仓汇总（5 卡）+ 加载失败 / 加载中 / 空态 + PRD §5.2.3 全 11 列持仓表。
 *
 * 数据全部由门面 HoldingsPage 以 props 下发；交互（错误态「重新加载」、空态
 * 「录入买卖」引导）以 emit 回传门面既有处理函数。本组件不发起任何数据请求
 * （避免与门面争抢同一会话造成死锁式重复请求）。EmptyState / ErrorState /
 * TableSkeleton 等展示组件均本地 import，不依赖门面已导入。
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import MetricCard from '@/components/common/MetricCard.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import InlinePriceEditor from './InlinePriceEditor.vue';
import { PackageOpen, Plus } from 'lucide-vue-next';
import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import type { HoldingResponse, HoldingsAggregate, Security } from '@/api/types';

defineProps<{
  /** 持仓汇总（含总市值 / 成本 / 浮盈 / 盈亏率 / 标的数），未加载时为 undefined */
  aggregate?: HoldingsAggregate;
  /** 前端排序后的持仓明细（正常在前、市值降序、已清仓垫底） */
  sortedItems: HoldingResponse[];
  /** 持仓加载中 */
  holdingsLoading: boolean;
  /** 持仓加载失败 */
  holdingsError: boolean;
  /** 证券主数据列表（空态文案判定用） */
  securityList: Security[];
  /** 当前组合 id（内联改价用）；门面仅在已选组合分支渲染本组件，恒为非空 */
  currentPortfolioId: string;
  /** 金额千分位偏好 */
  amountThousands?: boolean;
  /** 金额缩写偏好 */
  amountAbbrev?: boolean;
  /** 收益率小数位偏好 */
  xirrDecimals?: number;
}>();
const emit = defineEmits<{
  /** 错误态「重新加载」按钮 */
  refetch: [];
  /** 空态「录入买卖」引导按钮 */
  openTradeDialog: [];
}>();

// 证券类型中文标签（展示用；键为后端枚举值）
const SECURITY_TYPE_LABEL: Record<string, string> = {
  STOCK: '股票',
  ON_EXCHANGE_FUND: '场内基金',
  OFF_EXCHANGE_FUND: '场外基金',
  BOND: '债券',
  CASH: '现金',
  OTHER: '其他',
};
</script>

<template>
  <!-- 【A】汇总（HOLD-B-P0-06：含总盈亏率共 5 项；随筛选动态变化） -->
  <div v-if="aggregate" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    <MetricCard
      label="总市值"
      :value="formatCurrency(aggregate.totalMarketValue, 2, { thousands: amountThousands, abbreviate: amountAbbrev })"
    />
    <MetricCard
      label="总成本"
      :value="formatCurrency(aggregate.totalCost, 2, { thousands: amountThousands, abbreviate: amountAbbrev })"
    />
    <MetricCard
      label="浮盈"
      :value="(aggregate.totalProfit >= 0 ? '+' : '') + formatCurrency(aggregate.totalProfit, 2, { thousands: amountThousands, abbreviate: amountAbbrev })"
      :value-class-name="aggregate.totalProfit >= 0 ? 'text-up' : 'text-down'"
    />
    <!-- 【A3】总盈亏率（HOLD-B-P0-06）：红涨绿跌（§9.5） -->
    <MetricCard
      label="总盈亏率"
      :value="formatPercent(aggregate.totalProfitRate, 2, { decimals: xirrDecimals })"
      :value-class-name="aggregate.totalProfitRate >= 0 ? 'text-up' : 'text-down'"
    />
    <MetricCard
      label="标的数"
      :value="String(aggregate.securityCount)"
    />
  </div>

  <!-- 【B】持仓列表：加载失败 -->
  <ErrorState
    v-if="holdingsError"
    title="数据加载失败"
    description="持仓数据加载出错，请重试"
  >
    <template #action>
      <Button variant="outline" size="sm" @click="emit('refetch')">
        重新加载
      </Button>
    </template>
  </ErrorState>

  <TableSkeleton v-if="holdingsLoading" :rows="5" :cols="11" />

  <!-- 无结果空态 -->
  <EmptyState
    v-if="!holdingsLoading && !holdingsError && sortedItems.length === 0"
    title="暂无持仓数据"
    :description="
      securityList.length === 0
        ? '请先在「录入买卖」中搜索并选择标的，再录入买卖流水；持仓将自动推导'
        : '持仓由证券买卖流水实时推导，点击下方按钮录入第一笔买卖'
    "
  >
    <template #icon>
      <PackageOpen class="h-12 w-12" />
    </template>
    <template #action>
      <!-- INC-05：空态尺寸豁免，variant/图标/文案与页头主入口一致 -->
      <Button
        :variant="ENTRY_BUTTON_VARIANT"
        @click="emit('openTradeDialog')"
      >
        <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
        {{ ENTRY_BUTTON_LABELS.securityTrade }}
      </Button>
    </template>
  </EmptyState>

  <!-- 持仓表：PRD §5.2.3 全 11 列，顺序不可调整 -->
  <Card v-if="!holdingsLoading && !holdingsError && sortedItems.length > 0">
    <div class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="sticky left-0 z-10 bg-background">标的</TableHead>
            <TableHead>代码</TableHead>
            <TableHead>类型</TableHead>
            <TableHead class="text-right">数量</TableHead>
            <TableHead class="text-right">成本价</TableHead>
            <TableHead class="text-right">现价</TableHead>
            <TableHead class="text-right">成本额</TableHead>
            <TableHead class="text-right">市值</TableHead>
            <TableHead class="text-right">浮动盈亏</TableHead>
            <TableHead class="text-right">盈亏率</TableHead>
            <TableHead class="text-right">占比</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="h in sortedItems" :key="h.securityId">
            <TableCell class="sticky left-0 z-10 bg-background font-medium">
              <div class="flex items-center gap-2">
                {{ h.securityName }}
                <Badge
                  v-if="h.quantity === 0"
                  variant="outline"
                  class="text-[10px] text-muted-foreground"
                  title="已清仓标的（数量为 0）"
                >
                  已清仓
                </Badge>
                <Badge
                  v-if="h.flag === 'COST_BASED'"
                  variant="outline"
                  class="text-[10px] text-muted-foreground"
                  title="无现价记录，按成本价估值"
                >
                  成本估值
                </Badge>
              </div>
            </TableCell>
            <TableCell class="text-muted-foreground">
              {{ h.securityCode }}
            </TableCell>
            <TableCell>
              <Badge variant="secondary" class="text-xs">
                {{ SECURITY_TYPE_LABEL[h.securityType] || h.securityType }}
              </Badge>
            </TableCell>
            <TableCell class="text-right tabular-nums">
              {{ h.quantity.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }}
            </TableCell>
            <TableCell class="text-right tabular-nums">
              {{ formatCurrency(h.avgCost, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </TableCell>
            <TableCell class="text-right">
              <InlinePriceEditor
                :portfolio-id="currentPortfolioId"
                :security-id="h.securityId"
                :value="h.marketPrice"
                :price-as-of="h.priceAsOf"
                :flag="h.flag"
              />
            </TableCell>
            <!-- 【A2】成本额 -->
            <TableCell class="text-right tabular-nums">
              {{ formatCurrency(h.costTotal, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </TableCell>
            <TableCell class="text-right tabular-nums">
              {{ formatCurrency(h.marketValue, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </TableCell>
            <!-- 【A2】浮动盈亏：带正负号，红涨绿跌（§9.5） -->
            <TableCell
              :class="cn(
                'text-right tabular-nums',
                h.pnl >= 0 ? 'text-up' : 'text-down',
              )"
            >
              {{ h.pnl >= 0 ? '+' : '' }}{{ formatCurrency(h.pnl, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
            </TableCell>
            <!-- 【A2】盈亏率：红涨绿跌（§9.5） -->
            <TableCell
              :class="cn(
                'text-right tabular-nums',
                h.pnlRate >= 0 ? 'text-up' : 'text-down',
              )"
            >
              {{ formatPercent(h.pnlRate, 2, { decimals: xirrDecimals }) }}
            </TableCell>
            <!-- 【A5】占比：数值 + 横向进度条（HOLD-B-P0-04 验收5） -->
            <TableCell class="text-right tabular-nums">
              <div class="flex flex-col items-end gap-1">
                <span>{{ formatPercent(
                  aggregate && aggregate.totalMarketValue > 0
                    ? h.marketValue / aggregate.totalMarketValue
                    : 0,
                ) }}</span>
                <Progress
                  :value="
                    aggregate && aggregate.totalMarketValue > 0
                      ? (h.marketValue / aggregate.totalMarketValue) * 100
                      : 0
                  "
                  class="h-1.5 w-16"
                  :aria-label="`占比 ${formatPercent(
                    aggregate && aggregate.totalMarketValue > 0
                      ? h.marketValue / aggregate.totalMarketValue
                      : 0,
                  )}`"
                />
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </Card>
</template>
