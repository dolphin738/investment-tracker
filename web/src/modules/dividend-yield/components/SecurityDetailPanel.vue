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

const props = defineProps<{
  security: { master_id: string; code: string | null; name: string | null };
}>();

const emit = defineEmits<{ close: [] }>();

// 分红明细（按报告期）：后端已过滤掉无分红的期次（cash_per_share > 0），按报告期倒序
const dividends = useSecurityDividends(computed(() => props.security.master_id));
const dividendItems = computed(() => dividends.data.value?.items ?? []);
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
            class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <span class="shrink-0">{{ d.periodLabel }}</span>
            <span class="flex items-center gap-2">
              <Badge
                v-if="d.dividendLabel"
                variant="outline"
                class="shrink-0"
              >
                {{ d.dividendLabel }}
              </Badge>
              <span v-if="d.status !== 'PAID'" class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {{ d.status === 'PROPOSED' ? '预案' : d.status === 'REJECTED' ? '否决' : d.status }}
              </span>
              <span class="font-medium">{{ d.planLabel }}</span>
            </span>
          </li>
        </ul>
      </div>
    </CardContent>
  </Card>
</template>
