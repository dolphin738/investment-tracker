<script setup lang="ts">
/**
 * modules/dividend-yield/pages/DividendYieldRankPage.vue — 股息率榜单页（阶段5）
 *
 * 两块看板（页内 TAB 切换）：
 * - 股息率 Top20：useTop20()（后端已剔除 suspicious、封顶 20）
 * - 连续分红榜：useRank(sort=consecutive_years)，按连续分红年数排序（每页 30）
 *
 * 阈值标色：admin 时拉取 useDividendYieldSettings 的 green/red 阈值；
 * 无阈值数据（或未配置阈值）时股息率灰显（text-muted-foreground）。
 * stale 数据：行降透明度 + 标注「数据截至 {latest_trade_date}」。
 * 点击行 → 下方展开证券详情卡：近一年股息率曲线（useCurve）+ 目标收益率反推隐含价格（useImpliedPrice）。
 *
 * 安全：设置阈值仅 admin 可写（非 admin 无阈值 → 全部灰显）；admin 判定仅用于 UI 显示，
 * 真正的 403 由后端 require_admin 保证，前端不做授权唯一防线。
 */

import { computed, ref } from 'vue';
import type { EChartsOption } from 'echarts';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import BaseChart from '@/components/charts/BaseChart.vue';
import { useIsAdmin } from '@/stores/auth.store';
import { cn, formatPercent, formatCurrency } from '@/lib/utils';
import {
  useCurve,
  useImpliedPrice,
  useRank,
  useTop20,
  useDividendYieldSettings,
} from '../composables/use-dividend-yield';
import type { DividendYieldMode } from '@/api/types';

/** 页内看板 TAB */
type BoardTab = 'top20' | 'consecutive';

const innerTab = ref<BoardTab>('top20');

const isAdmin = computed(() => useIsAdmin());
// 阈值（admin 才拉取；非 admin 无阈值 → 股息率灰显）
const settingsQuery = useDividendYieldSettings(isAdmin);
const thresholds = computed(() => settingsQuery.data.value);

const top20 = useTop20();
const top20Items = computed(() => top20.data.value?.items ?? []);

// 连续分红榜（分页，每页 30）
const consecutiveRank = useRank(1, 30, 'consecutive_years', true);
const consecutiveItems = computed(
  () => consecutiveRank.data.value?.items ?? [],
);

/** 当前展示的数据源（供详情卡 / 曲线使用） */
const selected = ref<{
  master_id: string;
  code: string | null;
  name: string | null;
} | null>(null);

function selectRow(
  item: { master_id: string; code: string | null; name: string | null },
): void {
  selected.value = { ...item };
}

const curve = useCurve(computed(() => selected.value?.master_id ?? null));

// 目标收益率（小数比率），反推隐含价格
const targetRatio = ref<string>('');
const validRatio = computed<number | null>(() => {
  if (selected.value == null) return null;
  const t = targetRatio.value.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n;
});
const ratioError = computed(() => {
  if (!targetRatio.value.trim()) return null;
  return validRatio.value === null ? '须为 0 < 目标收益率 ≤ 1 的小数' : null;
});
const implied = useImpliedPrice(
  computed(() => selected.value?.master_id ?? null),
  validRatio,
  computed(() => selected.value != null),
);

/** 股息率标色：≥绿色阈值 text-up；≤红色阈值 text-down；其余/无阈值 灰显 */
function yieldClass(item: { dividend_yield: number | null }): string {
  const t = thresholds.value;
  if (!t || item.dividend_yield === null) return 'text-muted-foreground';
  if (t.green_threshold !== null && item.dividend_yield >= t.green_threshold) {
    return 'text-up';
  }
  if (t.red_threshold !== null && item.dividend_yield <= t.red_threshold) {
    return 'text-down';
  }
  return 'text-muted-foreground';
}

/** 近一年曲线 option（股息率 → 百分数） */
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
        connectNulls: true,
        smooth: true,
        symbolSize: 4,
        lineStyle: { width: 2 },
      },
    ],
  };
});

/** mode 中文标签 */
function modeLabel(mode: DividendYieldMode): string {
  return mode === 'TTM' ? 'TTM' : 'LFY';
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="股息率榜"
      description="Top20 股息率看板与连续分红榜；支持按股息率阈值着色（管理员配置）"
    />

    <Tabs v-model="innerTab">
      <TabsList>
        <TabsTrigger value="top20">股息率 Top20</TabsTrigger>
        <TabsTrigger value="consecutive">连续分红榜</TabsTrigger>
      </TabsList>

      <!-- Top20 -->
      <TabsContent value="top20">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">股息率 Top20</CardTitle>
            <CardDescription>
              后端已剔除可疑数据并封顶 20 只；数据截至按各标的最新行情日期标注
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Skeleton v-if="top20.isLoading.value" class="h-64 w-full" />
            <EmptyState
              v-else-if="top20Items.length === 0"
              title="暂无股息率数据"
              description="尚未同步可计算的股息率指标"
            />
            <div v-else class="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>代码 / 名称</TableHead>
                    <TableHead class="text-right">股息率</TableHead>
                    <TableHead class="text-right">连续分红年数</TableHead>
                    <TableHead class="text-right">最新价</TableHead>
                    <TableHead>数据状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="(item, idx) in top20Items"
                    :key="item.master_id"
                    :class="cn(
                      item.stale ? 'opacity-60' : '',
                      'cursor-pointer',
                    )"
                    @click="selectRow(item)"
                  >
                    <TableCell class="sticky left-0 z-10 bg-background">
                      <div class="flex items-center gap-2">
                        <Badge variant="secondary">{{ idx + 1 }}</Badge>
                        <div>
                          <p class="font-medium">
                            {{ item.name || item.code || '未命名' }}
                          </p>
                          <p class="font-mono text-xs text-muted-foreground">
                            {{ item.code || '-' }}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell
                      :class="cn(
                        'text-right font-mono tabular-nums',
                        yieldClass(item),
                      )"
                    >
                      {{ formatPercent(item.dividend_yield) }}
                    </TableCell>
                    <TableCell class="text-right font-mono tabular-nums">
                      {{ item.consecutive_years !== null ? `${item.consecutive_years} 年` : '-' }}
                    </TableCell>
                    <TableCell class="text-right font-mono tabular-nums">
                      {{ formatCurrency(item.latest_price) }}
                    </TableCell>
                    <TableCell>
                      <div class="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{{ modeLabel(item.mode) }}</Badge>
                        <Badge
                          v-if="item.stale"
                          variant="outline"
                        >
                          数据截至 {{ item.latest_trade_date ?? '-' }}
                        </Badge>
                        <Badge v-else variant="secondary">
                          最新
                        </Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <p class="mt-3 text-xs text-muted-foreground">
              注：股息率为小数比率（0.05 = 5%）。点击行可查看近一年股息率曲线与目标收益率反推价格。
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- 连续分红榜 -->
      <TabsContent value="consecutive">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">连续分红榜</CardTitle>
            <CardDescription>
              按连续分红年数（consecutive_years）降序，每页展示 30 条；stale 数据灰显
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Skeleton v-if="consecutiveRank.isLoading.value" class="h-64 w-full" />
            <EmptyState
              v-else-if="consecutiveItems.length === 0"
              title="暂无连续分红数据"
              description="尚未同步可计算的连续分红年数指标"
            />
            <div v-else class="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>代码 / 名称</TableHead>
                    <TableHead class="text-right">连续分红年数</TableHead>
                    <TableHead class="text-right">股息率</TableHead>
                    <TableHead class="text-right">最近分红年份</TableHead>
                    <TableHead>数据状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="item in consecutiveItems"
                    :key="item.master_id"
                    :class="cn('cursor-pointer', item.stale ? 'opacity-60' : '')"
                    @click="selectRow(item)"
                  >
                    <TableCell class="sticky left-0 z-10 bg-background">
                      <div>
                        <p class="font-medium">
                          {{ item.name || item.code || '未命名' }}
                        </p>
                        <p class="font-mono text-xs text-muted-foreground">
                          {{ item.code || '-' }}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell class="text-right font-mono tabular-nums">
                      {{ item.consecutive_years !== null ? `${item.consecutive_years} 年` : '-' }}
                    </TableCell>
                    <TableCell
                      :class="cn(
                        'text-right font-mono tabular-nums',
                        yieldClass(item),
                      )"
                    >
                      {{ formatPercent(item.dividend_yield) }}
                    </TableCell>
                    <TableCell class="text-right font-mono tabular-nums">
                      {{ item.last_dividend_year ?? '-' }}
                    </TableCell>
                    <TableCell>
                      <Badge
                        v-if="item.stale"
                        variant="outline"
                      >
                        数据截至 {{ item.latest_trade_date ?? '-' }}
                      </Badge>
                      <Badge v-else variant="secondary">最新</Badge>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- 证券详情：近一年曲线 + 目标收益率反推价格 -->
    <Card v-if="selected">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <span>{{ selected.name || selected.code || '' }}</span>
          <span class="font-mono text-sm text-muted-foreground">
            {{ selected.code || '未知代码' }}
          </span>
          <Button
            variant="ghost"
            size="sm"
            class="ml-auto"
            @click="selected = null"
          >
            关闭
          </Button>
        </CardTitle>
        <CardDescription>
          近一年股息率曲线（useCurve，365 天）与目标收益率反推隐含价格
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
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

        <!-- 目标收益率反推价格 -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="dy-target-ratio">目标股息率（小数，0 到 1）</Label>
            <Input
              id="dy-target-ratio"
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="如 0.06（6%）"
              v-model="targetRatio"
            />
            <p v-if="ratioError" class="text-xs text-red-500">
              {{ ratioError }}
            </p>
            <p v-else class="text-xs text-muted-foreground">
              按「每股分红 / 目标股息率」反推隐含价格
            </p>
          </div>
          <div class="space-y-2">
            <Label>隐含价格</Label>
            <div class="flex items-baseline gap-2 pt-1">
              <span
                v-if="implied.isLoading.value"
                class="text-sm text-muted-foreground"
              >
                计算中…
              </span>
              <span
                v-else-if="implied.data.value?.implied_price != null"
                class="font-mono text-lg font-semibold tabular-nums"
              >
                {{ formatCurrency(implied.data.value.implied_price) }}
              </span>
              <span v-else class="text-sm text-muted-foreground">-</span>
            </div>
            <p
              v-if="implied.data.value"
              class="text-xs text-muted-foreground"
            >
              每股股息分红
              {{ formatCurrency(implied.data.value.numerator_per_share) }}
             ，目标收益率
              {{ formatPercent(implied.data.value.target_ratio) }}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 阈值说明（admin 已配置时展示图例） -->
    <p
      v-if="thresholds && (thresholds.green_threshold != null || thresholds.red_threshold != null)"
      class="flex items-center gap-4 text-xs text-muted-foreground"
    >
      <!-- 标色语义（A 股「红涨绿跌」）：高股息率=红(--color-up)，低股息率=绿(--color-down)。
           阈值字段名仍沿用 green_threshold/red_threshold（服务端契约不变），
           但展示色按 A 股语义映射：≥绿色阈值→up(红)，≤红色阈值→down(绿)。 -->
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-3 w-3 rounded-sm" style="background: hsl(var(--color-up))" />
        股息率 ≥ {{ formatPercent(thresholds.green_threshold ?? 0) }}（红）
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-3 w-3 rounded-sm" style="background: hsl(var(--color-down))" />
        股息率 ≤ {{ formatPercent(thresholds.red_threshold ?? 0) }}（绿）
      </span>
      <span v-if="!isAdmin">
        （阈值由管理员在「设置 → 股息率」配置）
      </span>
    </p>
  </div>
</template>