<script setup lang="ts">
/**
 * modules/dividend-yield/components/SecurityDetailPanel.vue — 证券详情面板
 *
 * RankingPage / TopPage 行点击后共用：近一年股息率曲线（useCurve，缺段断开 §3.5）
 * + 目标收益率反推隐含价格（useImpliedPrice，含当前价/当前股息率对照 §9）。
 * 对应方案 §10.1 的 YieldCurveDialog + ImpliedPriceCalculator 能力聚合
 * （RankingPage 经 SecurityDetailDialog 以模态弹窗包装本面板；TopPage 仍为行下展开）。
 */
import { computed, ref } from 'vue';
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
import BaseChart from '@/components/charts/BaseChart.vue';
import { formatPercent, formatCurrency } from '@/lib/utils';
import { useCurve, useImpliedPrice } from '../composables/use-dividend-yield';

const props = defineProps<{
  security: { master_id: string; code: string | null; name: string | null };
}>();

const emit = defineEmits<{ close: [] }>();

const curve = useCurve(computed(() => props.security.master_id));

// 目标收益率（小数比率），反推隐含价格
const targetRatio = ref<string>('');
const validRatio = computed<number | null>(() => {
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
  computed(() => props.security.master_id),
  validRatio,
  computed(() => props.security != null),
);

/** 近一年曲线 option（股息率 → 百分数；缺段断开，§3.5/§7 缺失语义） */
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
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2 text-base">
        <span>{{ security.name || security.code || '' }}</span>
        <span class="font-mono text-sm text-muted-foreground">
          {{ security.code || '未知代码' }}
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
        近一年股息率曲线与目标收益率反推隐含价格
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
            v-model="targetRatio"
            type="number"
            min="0"
            max="1"
            step="0.01"
            placeholder="如 0.06（6%）"
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
            <template v-if="implied.data.value.current_price != null">
              ，当前价
              {{ formatCurrency(implied.data.value.current_price) }}
              （当前股息率
              {{ formatPercent(implied.data.value.current_dividend_yield) }}）
            </template>
          </p>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
