<script setup lang="ts">
/**
 * modules/holdings/pages/HoldingsPage.vue — 持仓页（PRD §7.2 · 方案B 只读推导 + I-05 统一筛选器）
 *
 * 平移自 React 版 web/src/pages/HoldingsPage.tsx。
 *
 * - 标题「+ 录入买卖」按钮 → 打开证券买卖录入弹窗（不是跳出入金页）
 * - I-05：页面顶部单一「统一筛选器」（HoldingsToolbar 原地升级），持仓 / 买卖明细 /
 *   分红费用三板块共享，状态单一来源 = URL query（useUrlState<HoldingsFilterState>）：
 *   - 日期范围（range/from/to）→ 买卖明细 / 分红费用
 *   - 持仓日期 as-of（date）→ 持仓板块
 *   - 证券多选（sec）→ 三板块
 *   - 场景（scenario）→ 买卖明细（side）；持仓不适用（INC-04 后分红板块不再承接 scenario）
 *   - 类型多选（types）+ 显示已清仓（closed）→ 持仓板块（专属折叠区）
 * - 【A】持仓汇总：总市值 / 总成本 / 浮盈 / 总盈亏率 / 标的数（HOLD-B-P0-06）
 * - 【B】持仓列表（只读，由 security-trades 推导），PRD §5.2.3 全 11 列
 * - 【C】证券买卖明细流水 / 【E】分红记录：security-trade、security-income 模块
 *   归属后续批次，当前渲染占位（见「行为差异」报告）
 * - 空态引导按钮 → 打开录入弹窗（与出入金页完全解耦）
 *
 * 排序（决策 Q-5 甲）：列表在前端按市值降序展示，不依赖后端排序参数。
 */
import { computed, ref, watch } from 'vue';
import { PackageOpen, Plus, AlertTriangle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import HoldingsToolbar from '../components/HoldingsToolbar.vue';
import InlinePriceEditor from '../components/InlinePriceEditor.vue';
import PriceFreshnessBadge from '../components/PriceFreshnessBadge.vue';
import { createHoldingsSchema } from '../query-params';
import type { HoldingsFilterState } from '../query-params';
import { deriveTradeSecurityFilter } from '../trade-security-filter';
import { resolveQuickRange } from '@/modules/query/quick-range';
import { useDefaultDateRange } from '@/composables/use-default-date-range';
import { usePortfolios } from '@/composables/use-portfolios';
import { useSecurities } from '@/composables/use-securities';
import { useHoldings } from '../composables/use-holdings';
import { useTransactions } from '@/modules/cashflow/composables/use-transactions';
import SecurityTradeForm from '@/modules/security-trade/components/SecurityTradeForm.vue';
import DividendList from '@/modules/security-income/components/DividendList.vue';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { todayInAppTzIso, toIsoDate } from '@/lib/constants';
import { useUrlState } from '@/lib/url-query';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';

// ===== 常量 =====
const SECURITY_TYPE_LABEL: Record<string, string> = {
  STOCK: '股票',
  ON_EXCHANGE_FUND: '场内基金',
  OFF_EXCHANGE_FUND: '场外基金',
  BOND: '债券',
  CASH: '现金',
  OTHER: '其他',
};

const portfolioStore = usePortfolioStore();
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const { data: portfoliosData, isLoading: portfoliosLoading } = usePortfolios();
const portfolios = computed(() => portfoliosData.value ?? []);
const preferenceStore = usePreferenceStore();
// 金额格式偏好用 computed 包裹：偏好异步到达后自动重算（对齐 React 每渲染取值）
const amountThousands = computed(() => preferenceStore.getPreference('amountThousands'));
const amountAbbrev = computed(() => preferenceStore.getPreference('amountAbbrev'));
// 盈亏率 / 总盈亏率沿用「收益率小数位」偏好（与概览页、分析页口径一致）
const xirrDecimals = computed(() => preferenceStore.getPreference('xirrDecimals'));

// 当前页签（React 版 defaultValue="holdings"；Tabs 为受控 defineModel 实现）
const activeTab = ref('holdings');

// 录入买卖弹窗（证券买卖录入表单，security-trade 批次）
const tradeDialogOpen = ref(false);

// ===== I-05：统一筛选器状态（单一来源 = URL query）=====
// date / closed / types / sec / range / from / to / scenario 全部走 useUrlState：
// 默认值不写入 URL、非法值降级、白名单外 key 保留；刷新/复制链接可还原。
const today = todayInAppTzIso();
const prefShowLiquidated = preferenceStore.getPreference('showLiquidated');
const defaultRangeRef = useDefaultDateRange();
const [holdingsQuery, setHoldingsQuery] = useUrlState<HoldingsFilterState>(
  createHoldingsSchema(today, prefShowLiquidated, defaultRangeRef.value),
);

// 用户交互守卫（QA 第 1 轮 Bug 修复）：
// 偏好对齐只允许在「偏好异步到达、且用户尚未主动操作该维度」时执行一次。
// 用户一旦手动改过 range/from/to（或 closed），对应标志置 true，此后永不再对齐，
// 避免「用户选择被偏好默认值弹回、URL 不写入」的问题（增量 PRD I-04 验收 2/3 + I-05 验收 5）。
const rangeInteracted = ref(false);
const closedInteracted = ref(false);

/** 统一筛选器变更入口：标记用户交互 + 写入 URL（useUrlState flush 异步落 URL） */
function handleFilterChange(patch: Partial<HoldingsFilterState>): void {
  if (
    patch.range !== undefined ||
    patch.from !== undefined ||
    patch.to !== undefined
  ) {
    rangeInteracted.value = true;
  }
  if (patch.closed !== undefined) {
    closedInteracted.value = true;
  }
  setHoldingsQuery(patch);
}

// 偏好对齐 1（closed）：偏好异步到达后，URL 无 closed 且用户未交互时对齐一次
const hasClosedParam = new URLSearchParams(window.location.search).has('closed');
watch(
  () => preferenceStore.getPreference('showLiquidated'),
  (prefShowLiquidatedNow) => {
    if (hasClosedParam || closedInteracted.value) return;
    if (prefShowLiquidatedNow && !holdingsQuery.closed) {
      setHoldingsQuery({ closed: true });
    }
  },
  { immediate: true },
);

// 偏好对齐 2（I-04）：偏好异步到达后，URL 无 range/from/to 且用户未交互时对齐一次
const initialSearchParams = new URLSearchParams(window.location.search);
const hasRangeParam =
  initialSearchParams.has('range') ||
  initialSearchParams.has('from') ||
  initialSearchParams.has('to');
watch(
  defaultRangeRef,
  (defaultRange) => {
    if (hasRangeParam || rangeInteracted.value) return;
    if (holdingsQuery.range !== defaultRange && defaultRange !== 'custom') {
      setHoldingsQuery({ range: defaultRange as HoldingsFilterState['range'] });
    }
  },
  { immediate: true },
);

// 日期选择器下限（O-4 方案甲，零后端改动）：首个交易日（useTransactions 首条）；
// 无交易 → 组合创建日；恒 ≤ 今天。
const firstTradeQuery = useTransactions(currentPortfolioId, {
  page: 1,
  pageSize: 1,
  sortBy: 'date',
  sortOrder: 'asc',
});
const currentPortfolio = computed(
  () => portfolios.value.find((p) => p.id === currentPortfolioId.value) ?? null,
);
// 组合首个交易日（baseDate，服务端计算、最可靠）
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);

// 持仓日期 as-of 下限：优先用 baseDate，其次首笔交易查询，再次组合创建日，最后回落今天。
// 修复缺陷3：原逻辑在首笔交易查询为空且无 createdAt 时会退化为今天，导致无法选择历史日期（as-of 被 min 卡死）。
const minDate = computed(() => {
  if (baseDate.value) return baseDate.value;
  const firstTradeDate = firstTradeQuery.data?.value?.items?.[0]?.date;
  if (firstTradeDate) return firstTradeDate;
  return currentPortfolio.value?.createdAt
    ? toIsoDate(new Date(currentPortfolio.value.createdAt))
    : today;
});

// I-05 三板块联动：日期范围解析（range=custom 用 from/to；否则按快捷项）
const resolvedRange = computed(() => {
  if (
    holdingsQuery.range === 'custom' &&
    holdingsQuery.from &&
    holdingsQuery.to
  ) {
    return { startDate: holdingsQuery.from, endDate: holdingsQuery.to };
  }
  return resolveQuickRange(holdingsQuery.range, {
    allRangeStart: baseDate.value ?? undefined,
  });
});
const startDate = computed(() => resolvedRange.value.startDate);
const endDate = computed(() => resolvedRange.value.endDate);

// 【持仓板块】as-of 精确推导 + 证券/类型/已清仓过滤
const holdingsParams = computed(() => ({
  date: holdingsQuery.date,
  includeClosed: holdingsQuery.closed,
  types: holdingsQuery.types.length > 0 ? holdingsQuery.types : undefined,
  securityId:
    holdingsQuery.sec.length > 0 ? holdingsQuery.sec.join(',') : undefined,
}));
const holdings = useHoldings(currentPortfolioId, holdingsParams);
const securities = useSecurities(currentPortfolioId);

/**
 * 【买卖明细板块】类型多选 + 证券多选 → 有效证券 ID 及其就绪状态（缺陷4 二次修复）。
 *
 * 派生规则与三态语义见 deriveTradeSecurityFilter 的文档注释；
 * 这里只负责把查询数据喂进纯函数，便于单测覆盖。
 */
const tradeSecurityFilter = computed(() =>
  deriveTradeSecurityFilter({
    types: holdingsQuery.types,
    sec: holdingsQuery.sec,
    securities: securities.data.value ?? [],
    securitiesLoading: securities.isLoading.value,
  }),
);

/**
 * 【A4】持仓列表前端排序（决策 Q-5 甲）：默认按市值降序。
 *
 * - 复制后再 sort，避免原地修改 vue-query 缓存数组。
 * - 占比权重基于 aggregate.totalMarketValue 计算，排序不影响权重。
 * - T02 追加：正常持仓（qty>0）恒排在已清仓（qty=0）之前；同组内市值降序。
 */
const sortedItems = computed(() =>
  [...(holdings.data.value?.items ?? [])].sort((a, b) => {
    const aOpen = a.quantity > 0 ? 0 : 1;
    const bOpen = b.quantity > 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return b.marketValue - a.marketValue;
  }),
);

const aggregate = computed(() => holdings.data.value?.aggregate);
const securityList = computed(() => securities.data.value ?? []);
const holdingsLoading = computed(() => holdings.isLoading.value);
const holdingsError = computed(() => holdings.isError.value);

/** 重新加载持仓（错误态按钮） */
function refetchHoldings(): void {
  holdings.refetch();
}
</script>

<template>
  <!-- ===== 加载态 ===== -->
  <div v-if="portfoliosLoading" class="space-y-6">
    <PageHeader title="持仓" />
    <TableSkeleton :rows="5" :cols="7" />
  </div>

  <!-- ===== 无组合 ===== -->
  <EmptyState
    v-else-if="portfolios.length === 0"
    title="暂无投资组合"
    description="创建组合后即可录入买卖并查看持仓"
  >
    <template #action>
      <Button disabled>
        请先在账户页「我的组合」创建组合
      </Button>
    </template>
  </EmptyState>

  <!-- ===== 未选组合 ===== -->
  <Card v-else-if="!currentPortfolioId" class="mx-auto max-w-md">
    <CardContent class="py-10 text-center text-sm text-muted-foreground">
      请先在顶部选择一个投资组合
    </CardContent>
  </Card>

  <div v-else class="space-y-6">
    <PageHeader
      title="持仓"
      description="持仓由证券买卖流水实时推导，只读展示；现价可内联修改"
    >
      <template #actions>
        <!-- Q3：行情数据新鲜度徽标（始终可见的轻量指示，独立 sync-status 判定） -->
        <PriceFreshnessBadge :portfolio-id="currentPortfolioId" />
        <Button
          :size="ENTRY_BUTTON_SIZE"
          :variant="ENTRY_BUTTON_VARIANT"
          @click="tradeDialogOpen = true"
        >
          <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
          {{ ENTRY_BUTTON_LABELS.securityTrade }}
        </Button>
      </template>
    </PageHeader>

    <!-- I-05 统一筛选器：三板块共享（持仓日期卡片重新设计承载） -->
    <HoldingsToolbar
      :value="holdingsQuery"
      :min-date="minDate"
      :all-range-start="baseDate"
      :securities="securityList"
      @change="handleFilterChange"
    />

    <Tabs v-model="activeTab">
      <TabsList>
        <TabsTrigger value="holdings">持仓</TabsTrigger>
        <TabsTrigger value="trades">买卖明细</TabsTrigger>
        <!-- 【E】HOLD-B-P0-10：分红 / 费用独立记录，不参与收益计算 -->
        <TabsTrigger value="income">分红</TabsTrigger>
      </TabsList>

      <!-- ============ 持仓 Tab ============ -->
      <TabsContent value="holdings" class="mt-4 space-y-6">
        <!-- 【A】汇总（HOLD-B-P0-06：含总盈亏率共 5 项；随筛选动态变化） -->
        <div v-if="aggregate" class="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Card>
            <CardContent class="py-3">
              <p class="text-xs text-muted-foreground">总市值</p>
              <p class="text-lg font-bold tabular-nums">
                {{ formatCurrency(aggregate.totalMarketValue, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="py-3">
              <p class="text-xs text-muted-foreground">总成本</p>
              <p class="text-lg font-bold tabular-nums">
                {{ formatCurrency(aggregate.totalCost, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="py-3">
              <p class="text-xs text-muted-foreground">浮盈</p>
              <p
                :class="cn(
                  'text-lg font-bold tabular-nums',
                  aggregate.totalProfit >= 0 ? 'text-up' : 'text-down',
                )"
              >
                {{ aggregate.totalProfit >= 0 ? '+' : '' }}{{ formatCurrency(aggregate.totalProfit, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
              </p>
            </CardContent>
          </Card>
          <!-- 【A3】总盈亏率（HOLD-B-P0-06）：红涨绿跌（§9.5） -->
          <Card>
            <CardContent class="py-3">
              <p class="text-xs text-muted-foreground">总盈亏率</p>
              <p
                :class="cn(
                  'text-lg font-bold tabular-nums',
                  aggregate.totalProfitRate >= 0 ? 'text-up' : 'text-down',
                )"
              >
                {{ formatPercent(aggregate.totalProfitRate, 2, { decimals: xirrDecimals }) }}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="py-3">
              <p class="text-xs text-muted-foreground">标的数</p>
              <p class="text-lg font-bold tabular-nums">
                {{ aggregate.securityCount }}
              </p>
            </CardContent>
          </Card>
        </div>

        <!-- 【B】持仓列表：加载失败 -->
        <Card v-if="holdingsError" class="border-destructive/50">
          <CardContent class="flex flex-col items-center gap-4 py-8">
            <AlertTriangle class="h-8 w-8 text-destructive" />
            <p class="text-sm text-destructive">数据加载失败</p>
            <Button variant="outline" size="sm" @click="refetchHoldings">
              重新加载
            </Button>
          </CardContent>
        </Card>

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
              @click="tradeDialogOpen = true"
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
                  <TableHead>标的</TableHead>
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
                  <TableCell class="font-medium">
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
      </TabsContent>

      <!-- ============ 买卖明细 Tab（security-trade 模块归属后续批次） ============ -->
      <TabsContent value="trades" class="mt-4 space-y-4">
        <Card>
          <CardContent class="py-10 text-center text-sm text-muted-foreground">
            买卖明细列表将在 security-trade 模块批次迁移后接入
            <p class="mt-1 text-xs">
              筛选联动已就绪（当前有效标的
              {{ tradeSecurityFilter.state === 'ready' ? tradeSecurityFilter.ids.length : 0 }}
              项，日期范围 {{ startDate }} 至 {{ endDate }}）
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ============ 分红 Tab（security-income 模块归属本批次） ============ -->
      <TabsContent value="income" class="mt-4">
        <DividendList
          :portfolio-id="currentPortfolioId ?? ''"
          :security-ids="holdingsQuery.sec"
          :start-date="startDate"
          :end-date="endDate"
        />
      </TabsContent>
    </Tabs>

    <!-- 录入/编辑证券买卖弹窗 -->
    <Dialog v-model:open="tradeDialogOpen">
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ ENTRY_BUTTON_LABELS.securityTrade }}</DialogTitle>
        </DialogHeader>
        <SecurityTradeForm
          :portfolio-id="currentPortfolioId ?? ''"
          @success="tradeDialogOpen = false"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>
