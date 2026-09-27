<script setup lang="ts">
/**
 * modules/dividend-yield/components/SecurityDetailPanel.vue — 证券详情面板
 *
 * RankingPage / TopPage 行点击后共用：展示该证券的分红明细（按报告期，仅显示有分红的期次）。
 * 原「近一年股息率曲线」区块已随 curve 接口下线的同时移除（见删除说明）。
 * 对应方案 §10.1 的 YieldCurveDialog 能力聚合
 * （RankingPage 经 SecurityDetailDialog 以模态弹窗包装本面板；TopPage 仍为行下展开）。
 */
import { computed } from 'vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useSecurityDividends } from '../composables/use-dividend-yield';
import type { SecurityDividendItem } from '@/api/dividend-yield.api';

const props = defineProps<{
  security: { master_id: string; code: string | null; name: string | null };
}>();

const emit = defineEmits<{ close: [] }>();

// 分红明细（按报告期）：后端已过滤掉无分红的期次（cash_per_share > 0），按报告期倒序
const dividends = useSecurityDividends(computed(() => props.security.master_id));
const dividendItems = computed(() => dividends.data.value?.items ?? []);

// 金额列：组合「每 10 股派 X.XX 元 + 送 Y 股 + 转 Z 股」（送转同为每 10 股口径，
// 由每股比例 ×10 折算，两位小数 + 数字对齐）；cashPerShare 缺失/非法时回退后端整串 planLabel。
function per10PlanLabel(d: SecurityDividendItem): string {
  const parts: string[] = [];
  const cash = Number(d.cashPerShare);
  if (d.cashPerShare && !Number.isNaN(cash)) {
    parts.push(`10派${(cash * 10).toFixed(2)}元`);
  }
  const bonus = Number(d.bonusShareRatio);
  if (d.bonusShareRatio && !Number.isNaN(bonus) && bonus > 0) {
    parts.push(`送${(bonus * 10).toFixed(2)}股`);
  }
  const convert = Number(d.convertRatio);
  if (d.convertRatio && !Number.isNaN(convert) && convert > 0) {
    parts.push(`转${(convert * 10).toFixed(2)}股`);
  }
  return parts.length ? parts.join(' ') : d.planLabel;
}
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
      <CardDescription>分红明细（按报告期，仅显示有分红的期次）</CardDescription>
    </CardHeader>
    <CardContent>
      <div class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-sm font-medium">分红明细</span>
          <span class="text-xs text-muted-foreground">仅显示有分红的报告期</span>
        </div>
        <Skeleton v-if="dividends.isLoading.value" class="h-24 w-full" />
        <div
          v-else-if="dividends.isError.value"
          class="flex h-16 items-center justify-center text-sm text-red-500"
        >
          分红数据加载失败
        </div>
        <div
          v-else-if="dividendItems.length === 0"
          class="flex h-16 items-center justify-center text-sm text-muted-foreground"
        >
          暂无分红记录
        </div>
        <ul v-else class="max-h-52 divide-y overflow-y-auto rounded-md border">
          <li
            v-for="d in dividendItems"
            :key="`${d.reportYear}-${d.reportQuarter}-${d.periodType}`"
            class="grid grid-cols-[5.5rem_5rem_1fr_auto] items-center gap-2 px-3 py-2 text-sm"
          >
            <span class="shrink-0 text-muted-foreground">{{ d.periodLabel }}</span>
            <span class="truncate overflow-hidden">
              <Badge
                v-if="d.dividendLabel"
                variant="outline"
                class="shrink-0"
              >
                {{ d.dividendLabel }}
              </Badge>
            </span>
            <span class="text-right font-medium tabular-nums">{{ per10PlanLabel(d) }}</span>
            <span class="shrink-0">
              <span v-if="d.status !== 'PAID'" class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {{ d.status === 'PROPOSED' ? '预案' : d.status === 'REJECTED' ? '否决' : d.status }}
              </span>
            </span>
          </li>
        </ul>
      </div>
    </CardContent>
  </Card>
</template>
