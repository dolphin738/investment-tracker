<script setup lang="ts">
/**
 * modules/security-price/components/PriceHistoryList.vue — 价格历史列表
 *
 * 基于 security-prices 列表 API 按组合（可选按标的过滤）展示各估值日期的现价记录。
 * - 无组合：EmptyState 提示先选择投资组合
 * - 加载中：TableSkeleton
 * - 加载失败：错误提示卡
 * - 无任何记录：EmptyState 空态（无价格历史）
 *
 * 现价展示/新鲜度由持仓页的 PriceFreshnessBadge 负责（B5 已建），本组件不重复。
 */
import { computed } from 'vue';
import { History } from 'lucide-vue-next';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import { useSecurityPrices } from '../composables/use-security-prices';
import type { SecurityPriceQuery } from '@/api/types';

const props = defineProps<{
  /** 组合 id（null 时展示选择组合空态） */
  portfolioId: string | null;
  /** 按标的过滤（可选） */
  securityId?: string;
  /** 列表标题，默认「价格历史」 */
  title?: string;
}>();

const query = computed<SecurityPriceQuery>(() =>
  props.securityId ? { securityId: props.securityId } : {},
);

const priceQuery = useSecurityPrices(
  computed(() => props.portfolioId),
  query.value,
);

const priceItems = computed(() => priceQuery.data.value?.items ?? []);
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-muted-foreground">
        {{ title ?? '价格历史' }}
      </h3>
    </div>

    <!-- 无组合 -->
    <EmptyState
      v-if="!portfolioId"
      title="请先选择投资组合"
      description="选择组合后即可查看各标的的价格历史"
    />

    <!-- 加载失败 -->
    <Card
      v-else-if="priceQuery.isError.value"
      class="border-destructive/50"
    >
      <CardContent class="py-6 text-center text-sm text-destructive">
        价格历史加载失败
      </CardContent>
    </Card>

    <!-- 加载中 -->
    <TableSkeleton v-else-if="priceQuery.isLoading.value" :rows="4" :cols="3" />

    <!-- 空态：无价格历史 -->
    <EmptyState
      v-else-if="priceItems.length === 0"
      title="暂无价格历史"
      description="录入现价或同步行情后，这里将展示各估值日期的最新价"
    >
      <template #icon>
        <History class="h-12 w-12" />
      </template>
    </EmptyState>

    <!-- 列表 -->
    <Card v-else>
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>估值日期</TableHead>
              <TableHead class="text-right">价格</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="r in priceItems" :key="r.id">
              <TableCell class="text-muted-foreground">{{ r.asOf }}</TableCell>
              <TableCell class="text-right tabular-nums">
                {{ Number(r.price).toLocaleString('zh-CN', { maximumFractionDigits: 6 }) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </Card>
  </div>
</template>