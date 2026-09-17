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
import {
  buildDividendYieldCurveOption,
} from '@/components/charts/dividend-yield-curve-chart';
import { useChartTheme } from '@/lib/chart-theme';
import { formatPercent } from '@/lib/utils';
import { useCurve } from '../composables/use-dividend-yield';
import { useYieldThresholds } from '../composables/use-yield-thresholds';

const props = defineProps<{
  security: { master_id: string; code: string | null; name: string | null };
}>();

const emit = defineEmits<{ close: [] }>();

const curve = useCurve(computed(() => props.security.master_id));
const theme = useChartTheme();
// 高股息阈值随账号存储（用户偏好，见 0026 迁移）：全局偏好由 PreferenceBootstrap 首屏加载，
// 登录即可读、无 admin 门控；缺失时 composable 回退默认 0.05。
const { thresholds } = useYieldThresholds();

/** 参考线阈值（百分数）：green_threshold 为小数比率（0.05）→ 5（恒有值，带默认兜底） */
const pivotPercent = computed<number>(() =>
  Number((thresholds.value.green_threshold * 100).toFixed(2)),
);

/**
 * 近一年双轴曲线 option：左轴 股息率(%)、右轴 收盘价(¥)，含高股息线虚线（阈值跟随全局设置）。
 * 经 useChartTheme() 建立响应式依赖，明暗主题切换时自动重算配色（修复旧内联硬编码回归）。
 */
const curveOption = computed<EChartsOption>(() =>
  buildDividendYieldCurveOption({
    items: curve.data.value?.items ?? [],
    theme: theme.value,
    pivotPercent: pivotPercent.value,
  }),
);
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
      <CardDescription>近一年股息率(%) 与 收盘价(¥) 双轴曲线</CardDescription>
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
        aria-label="近一年股息率与收盘价双轴曲线"
        :summary="`近一年股息率曲线，最新 ${formatPercent(curve.data.value.items[curve.data.value.items.length - 1]?.dividend_yield)}`"
      />
    </CardContent>
  </Card>
</template>
