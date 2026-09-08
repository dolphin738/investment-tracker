<script setup lang="ts">
/**
 * modules/dividend-yield/components/SecurityDetailPanel.vue — 证券详情面板
 *
 * RankingPage / TopPage 行点击后共用，方案 §10.1/§10.2（2026-09-08 增量）：
 * Tabs 分页「排名 / 曲线 / 反推价格」（对应原 YieldCurveDialog + ImpliedPriceCalculator
 * 能力聚合，采用行下展开面板而非弹窗，避免 reka-ui Dialog Portal 渲染层级）。
 * - 排名：快照指标总览（股息率标色 / 分子 / 最新价 / 连续年数 / 口径 / 数据状态）；
 * - 曲线：近一年股息率曲线（useCurve，缺段断开 §3.5）；
 * - 反推价格：目标股息率价格推算（§9）——选股栏支持输入代码/名称搜索切换（/search），
 *   按「每股派息 ÷ 目标股息率」实时给出隐含价格结果卡与 3%~8% 快速参考格。
 */
import { computed, ref, watch } from 'vue';
import type { EChartsOption } from 'echarts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-vue-next';
import BaseChart from '@/components/charts/BaseChart.vue';
import { formatPercent, formatCurrency } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import {
  useCurve,
  useImpliedPrice,
  useSearchDividendYieldSecurities,
} from '../composables/use-dividend-yield';
import { useYieldThresholds } from '../composables/use-yield-thresholds';
import type { DividendYieldMode, DividendYieldRankItem } from '@/api/types';

const props = defineProps<{
  security: { master_id: string; code: string | null; name: string | null };
  /** 行点击带入的榜单行（排名 TAB 初始数据；选股切换后由 /search 结果补位） */
  rank?: DividendYieldRankItem | null;
}>();

const emit = defineEmits<{ close: [] }>();

/** 阈值标色与两页共用同一来源（全局配置；非 admin 无阈值 → 灰显） */
const { yieldClass } = useYieldThresholds(() => useIsAdmin());

// ── 当前证券（选股栏可切换；props 变化（换行点击）时重置） ──
const activeSec = ref({ ...props.security });
const rankRow = ref<DividendYieldRankItem | null>(props.rank ?? null);
const activeTab = ref<'rank' | 'curve' | 'implied'>('rank');

watch(
  () => props.security.master_id,
  () => {
    activeSec.value = { ...props.security };
    rankRow.value = props.rank ?? null;
    activeTab.value = 'rank';
  },
);

/** 排名 TAB 数据：优先行点击带入的榜单行，选股切换后用 /search 返回的快照行 */
const displayRank = computed<DividendYieldRankItem | null>(() => {
  if (rankRow.value?.master_id === activeSec.value.master_id) return rankRow.value;
  return null;
});

// ── 排名 TAB ──
function modeLabel(mode: DividendYieldMode): string {
  return mode === 'TTM' ? 'TTM' : 'LFY';
}

// ── 曲线 TAB（§9 逐点现算；缺段断开 §3.5） ──
const curve = useCurve(computed(() => activeSec.value.master_id));

const curveOption = computed<EChartsOption>(() => {
  const items = curve.data.value?.items ?? [];
  const x = items.map((i) => i.trade_date);
  const y = items.map((i) =>
    i.dividend_yield !== null
      ? Number((i.dividend_yield * 100).toFixed(2))
      : null,
  );
  return {
    color: ['hsl(var(--primary))'],
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => `${v}%`,
    },
    grid: { left: 48, right: 16, top: 16, bottom: 24 },
    xAxis: {
      type: 'category',
      data: x,
      axisLabel: { fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: '{value}%' },
    },
    series: [
      {
        type: 'line',
        data: y,
        connectNulls: false,
        smooth: true,
        symbolSize: 4,
        lineStyle: { width: 2 },
      },
    ],
  };
});

// ── 反推价格 TAB：选股栏（输入代码/名称搜索，§10.2） ──
const stockQuery = ref('');
const selectedLabel = computed(() =>
  `${activeSec.value.code ?? ''} ${activeSec.value.name ?? ''}`.trim(),
);
const searchInput = ref<HTMLInputElement | null>(null);
const showResults = ref(false);

/** 300ms 防抖关键字；等于当前选中标签时不搜索 */
const debouncedQ = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(stockQuery, (v) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debouncedQ.value = v.trim();
  }, 300);
});
const searchEnabled = computed(
  () =>
    activeTab.value === 'implied' &&
    debouncedQ.value !== '' &&
    debouncedQ.value !== selectedLabel.value,
);
const searchQuery = useSearchDividendYieldSecurities(debouncedQ, searchEnabled);
const searchItems = computed(() => searchQuery.data.value?.items ?? []);

function selectStock(item: DividendYieldRankItem): void {
  activeSec.value = {
    master_id: item.master_id,
    code: item.code,
    name: item.name,
  };
  rankRow.value = item;
  stockQuery.value = selectedLabel.value;
  debouncedQ.value = selectedLabel.value;
  showResults.value = false;
}

// ── 反推价格 TAB：目标股息率 → 隐含价格（§9，按钮/回车触发） ──
const targetPercent = ref<string>('');
const validPercent = computed<number | null>(() => {
  const t = targetPercent.value.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
});
const percentError = computed(() => {
  if (!targetPercent.value.trim()) return null;
  return validPercent.value === null ? '须为 0 < 目标股息率 ≤ 100 的数字' : null;
});

const confirmedRatio = ref<number | null>(null);
const implied = useImpliedPrice(
  computed(() => activeSec.value.master_id),
  computed(() => confirmedRatio.value),
  computed(() => confirmedRatio.value !== null),
);

function computeImplied(): void {
  confirmedRatio.value = validPercent.value === null ? null : validPercent.value / 100;
}

/** 每股派息（TTM/LFY 分子，元/股）——来自排名快照 */
const numerator = computed(() => displayRank.value?.numerator_per_share ?? null);

/** 换股后重算：目标股息率仍有效则按新分子重算，否则清空旧结果 */
watch(() => activeSec.value.master_id, () => {
  if (validPercent.value !== null) computeImplied();
  else confirmedRatio.value = null;
});

/** 快速参考（基于当前每股派息，3%~8%）：客户端直算 每股派息 ÷ 比率 */
const QUICK_RATIOS = [0.03, 0.04, 0.05, 0.06, 0.07, 0.08] as const;
function quickPrice(ratio: number): number | null {
  if (numerator.value === null) return null;
  return numerator.value / ratio;
}
function applyQuick(ratio: number): void {
  if (quickPrice(ratio) === null) return;
  targetPercent.value = String(ratio * 100);
  computeImplied();
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2 text-base">
        <span>{{ activeSec.name || activeSec.code || '' }}</span>
        <span class="font-mono text-sm text-muted-foreground">
          {{ activeSec.code || '未知代码' }}
        </span>
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto"
          @click="emit('close')"
        >
          关闭
        </Button>
      </CardTitle>
      <CardDescription>
        排名快照 · 近一年股息率曲线 · 目标股息率价格推算
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-5">
      <Tabs v-model="activeTab">
        <TabsList>
          <TabsTrigger value="rank">排名</TabsTrigger>
          <TabsTrigger value="curve">曲线</TabsTrigger>
          <TabsTrigger value="implied">反推价格</TabsTrigger>
        </TabsList>
      </Tabs>

      <!-- TAB 1：排名快照 -->
      <div v-if="activeTab === 'rank'" class="space-y-3">
        <template v-if="displayRank">
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">股息率（税前）</p>
              <p
                class="font-mono text-lg font-semibold tabular-nums"
                :class="yieldClass(displayRank)"
              >
                {{ formatPercent(displayRank.dividend_yield) }}
              </p>
            </div>
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">每股分红（元）</p>
              <p class="font-mono text-lg font-semibold tabular-nums">
                {{ formatCurrency(displayRank.numerator_per_share) }}
              </p>
            </div>
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">最新价（元）</p>
              <p class="font-mono text-lg font-semibold tabular-nums">
                {{ formatCurrency(displayRank.latest_price) }}
              </p>
            </div>
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">连续分红年数</p>
              <p class="font-mono text-lg font-semibold tabular-nums">
                {{ displayRank.consecutive_years ?? '-' }}
              </p>
            </div>
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">最近分红年份</p>
              <p class="font-mono text-lg font-semibold tabular-nums">
                {{ displayRank.last_dividend_year ?? '-' }}
              </p>
            </div>
            <div class="space-y-1">
              <p class="text-xs text-muted-foreground">口径</p>
              <div class="flex flex-wrap items-center gap-1 pt-1">
                <Badge variant="outline">{{ modeLabel(displayRank.mode) }}</Badge>
                <Badge v-if="displayRank.filtered" variant="secondary">过滤态</Badge>
              </div>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            数据状态：
            <Badge v-if="displayRank.stale" variant="outline">
              数据截至 {{ displayRank.latest_trade_date ?? '-' }}
            </Badge>
            <Badge v-else variant="secondary">最新</Badge>
          </p>
        </template>
        <div v-else class="py-6 text-center text-sm text-muted-foreground">
          暂无排名快照（可在「反推价格」TAB 切换有快照的证券）
        </div>
      </div>

      <!-- TAB 2：近一年曲线 -->
      <div v-else-if="activeTab === 'curve'">
        <Skeleton v-if="curve.isLoading.value" class="h-[260px] w-full" />
        <div
          v-else-if="!curve.data.value || curve.data.value.items.length === 0"
          class="flex h-[260px] items-center justify-center text-sm text-muted-foreground"
        >
          暂无曲线数据
        </div>
        <BaseChart
          v-else
          :option="curveOption"
          :height="260"
          aria-label="近一年股息率曲线"
          :summary="`近一年股息率曲线，最新 ${formatPercent(curve.data.value.items[curve.data.value.items.length - 1]?.dividend_yield)}`"
        />
      </div>

      <!-- TAB 3：目标股息率价格推算（§9） -->
      <div v-else class="space-y-5">
        <!-- 选股栏：输入代码/名称搜索切换 -->
        <div class="relative space-y-2">
          <Label for="dy-stock-picker">选择股票</Label>
          <Input
            id="dy-stock-picker"
            v-model="stockQuery"
            :placeholder="selectedLabel || '输入代码或名称搜索（如 600036）'"
            autocomplete="off"
            @focus="showResults = true"
            @blur="showResults = false"
          />
          <div
            v-if="showResults && searchEnabled && searchItems.length > 0"
            class="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover shadow-md"
          >
            <button
              v-for="item in searchItems"
              :key="item.master_id"
              type="button"
              class="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
              @mousedown.prevent
              @click="selectStock(item)"
            >
              <span class="font-mono">{{ item.code }}</span>
              <span>{{ item.name }}</span>
              <span class="text-xs text-muted-foreground">
                {{ formatPercent(item.dividend_yield) }}
              </span>
            </button>
          </div>
          <p v-if="searchEnabled && searchQuery.isLoading.value" class="text-xs text-muted-foreground">
            搜索中…
          </p>
        </div>

        <!-- 输入区：每股派息（只读） + 目标股息率 -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="dy-ttm-numerator">每股派息（过去 12 个月，元/股）</Label>
            <Input
              id="dy-ttm-numerator"
              :model-value="numerator != null ? String(numerator) : ''"
              type="number"
              readonly
              placeholder="暂无快照分子"
            />
          </div>
          <div class="space-y-2">
            <Label for="dy-target-percent">目标股息率（%）</Label>
            <Input
              id="dy-target-percent"
              v-model="targetPercent"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder="如 6（即 6%）"
              @keyup.enter="computeImplied"
            />
            <p v-if="percentError" class="text-xs text-red-500">
              {{ percentError }}
            </p>
          </div>
        </div>

        <Button
          class="w-full"
          :disabled="validPercent === null || numerator === null"
          @click="computeImplied"
        >
          <Loader2 v-if="implied.isLoading.value" class="mr-1 h-4 w-4 animate-spin" />
          计算目标价格
        </Button>

        <!-- 结果卡 -->
        <div
          v-if="implied.data.value && implied.data.value.implied_price != null"
          class="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-5 text-center"
        >
          <p class="text-sm text-muted-foreground">
            每股派息 {{ formatCurrency(implied.data.value.numerator_per_share) }}
            ｜ 目标股息率
            {{ formatPercent(implied.data.value.target_ratio) }}
          </p>
          <p class="font-mono text-3xl font-bold text-primary tabular-nums">
            {{ formatCurrency(implied.data.value.implied_price) }}
          </p>
          <p class="text-xs text-muted-foreground">
            公式：每股派息 {{ formatCurrency(implied.data.value.numerator_per_share) }}
            ÷ {{ formatPercent(implied.data.value.target_ratio) }}
            = {{ formatCurrency(implied.data.value.implied_price) }} 元
          </p>
          <p class="text-xs text-muted-foreground">
            当股价 ≤ {{ formatCurrency(implied.data.value.implied_price) }}
            时，股息率 ≥
            {{ formatPercent(implied.data.value.target_ratio) }}
            <template v-if="implied.data.value.current_price != null">
              （当前价
              {{ formatCurrency(implied.data.value.current_price) }}
              ，当前股息率
              {{ formatPercent(implied.data.value.current_dividend_yield) }}）
            </template>
          </p>
        </div>
        <p
          v-else-if="confirmedRatio !== null && implied.isLoading.value"
          class="text-center text-sm text-muted-foreground"
        >
          计算中…
        </p>

        <!-- 快速参考（基于当前每股派息） -->
        <div v-if="numerator !== null" class="space-y-2">
          <p class="text-sm font-medium">快速参考（基于当前每股派息）</p>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="ratio in QUICK_RATIOS"
              :key="ratio"
              type="button"
              class="space-y-1 rounded-md border p-3 text-center hover:border-primary/40 hover:bg-accent"
              @click="applyQuick(ratio)"
            >
              <p class="font-mono text-sm font-semibold text-primary">
                {{ ratio * 100 }}%
              </p>
              <p class="font-mono text-xs text-muted-foreground tabular-nums">
                {{ formatCurrency(quickPrice(ratio)) }}
              </p>
            </button>
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
