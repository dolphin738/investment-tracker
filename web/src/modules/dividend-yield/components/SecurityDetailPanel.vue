<script setup lang="ts">
/**
 * modules/dividend-yield/components/SecurityDetailPanel.vue — 证券详情面板
 *
 * RankingPage / TopPage 行点击后共用：近一年股息率曲线（useCurve，缺段断开 §3.5）。
 * 原「目标收益率反推隐含价格」区块已迁出为独立组件 ImpliedPriceCalculator
 * （RankingPage「股息价格推算」Tab 承载，本面板不再包含该功能入口）。
 * 对应方案 §10.1 的 YieldCurveDialog 能力聚合
 * （RankingPage 经 SecurityDetailDialog 以模态弹窗包装本面板；TopPage 仍为行下展开）。
 */
import { computed } from 'vue';
import type { EChartsOption } from 'echarts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { formatPercent } from '@/lib/utils';
import { useCurve } from '../composables/use-dividend-yield';

const props = defineProps<{
  security: { master_id: string; code: string | null; name: string | null };
}>();

const emit = defineEmits<{ close: [] }>();

const curve = useCurve(computed(() => props.security.master_id));

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
      <CardDescription>近一年股息率曲线</CardDescription>
    </CardHeader>
    <CardContent>
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
    </CardContent>
  </Card>
</template>
