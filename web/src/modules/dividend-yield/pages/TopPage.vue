<script setup lang="ts">
/**
 * modules/dividend-yield/pages/TopPage.vue — 展示页（§10.3 / 决策 A13）
 *
 * 只读双榜（数据单一来源 /top20）：上半 Top20 榜（剔除 suspicious 与近两年无分红）、
 * 下半连续分红榜（consecutive_years >= 2，条数上限 20，带「查看全部」出口跳管理页）。
 * 标色/灰显语义与 RankingPage 共用 use-yield-thresholds。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ROUTE_PATH } from '@/lib/constants';
import { cn, formatPercent, formatCurrency } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import { useTop20 } from '../composables/use-dividend-yield';
import { useYieldThresholds } from '../composables/use-yield-thresholds';
import SecurityDetailPanel from '../components/SecurityDetailPanel.vue';
import type { DividendYieldMode } from '@/api/types';

const router = useRouter();
const { thresholds, yieldClass } = useYieldThresholds(() => useIsAdmin());

const top20 = useTop20();
const topItems = computed(() => top20.data.value?.top ?? []);
const consecutiveItems = computed(() => top20.data.value?.consecutive ?? []);

/** 行点击 → 下方展开详情面板（曲线 + 计算器） */
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

/** §10.3「查看全部」出口：跳管理页并带 min_consecutive 过滤 */
function goRankingWithConsecutive(): void {
  void router.push({ path: ROUTE_PATH.DIVIDEND_YIELD, query: { min_consecutive: '2' } });
}

function modeLabel(mode: DividendYieldMode): string {
  return mode === 'TTM' ? 'TTM' : 'LFY';
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="股息率 Top20"
      description="股息率看板与连续分红公司榜（只读）；管理与筛选请前往「股息率排名」"
    >
      <template #actions>
        <Button variant="outline" size="sm" @click="goRankingWithConsecutive">
          查看全部（连续 ≥2 年）
        </Button>
      </template>
    </PageHeader>

    <div class="space-y-6">
      <!-- 榜一：股息率 Top20 -->
      <Card>
        <CardHeader>
          <CardTitle class="text-base">股息率 Top20</CardTitle>
          <CardDescription>
            已剔除可疑数据与近两年无分红公司，封顶 20；第 20/21 名同值不并列扩榜（§8.3）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TableSkeleton v-if="top20.isLoading.value" :rows="8" :cols="5" />
          <EmptyState
            v-else-if="topItems.length === 0"
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
                  v-for="(item, idx) in topItems"
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
                      <Badge v-if="item.stale" variant="outline">
                        数据截至 {{ item.latest_trade_date ?? '-' }}
                      </Badge>
                      <Badge v-else variant="secondary">最新</Badge>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <!-- 榜二：连续分红公司榜 -->
      <Card>
        <CardHeader>
          <CardTitle class="text-base">连续分红公司榜</CardTitle>
          <CardDescription>
            连续分红 ≥2 年，按连续年数与股息率降序；条数上限 20（决策 A13）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            v-if="!top20.isLoading.value && consecutiveItems.length === 0"
            title="暂无连续分红数据"
            description="尚未同步可计算的连续分红年数指标"
          />
          <div v-else-if="consecutiveItems.length > 0" class="overflow-x-auto">
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
                    <div class="flex items-center gap-2">
                      <Badge variant="secondary">{{ item.consecutive_years }} 年</Badge>
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
                  <TableCell class="text-right font-mono tabular-nums">
                    {{ item.consecutive_years ?? '-' }}
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
                    <Badge v-if="item.stale" variant="outline">
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
    </div>

    <!-- 证券详情面板（与 RankingPage 共用） -->
    <SecurityDetailPanel
      v-if="selected"
      :security="selected"
      @close="selected = null"
    />

    <!-- 阈值图例（A 股「红涨绿跌」语义，字段名沿用服务端契约） -->
    <p
      v-if="thresholds && (thresholds.green_threshold != null || thresholds.red_threshold != null)"
      class="flex items-center gap-4 text-xs text-muted-foreground"
    >
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-3 w-3 rounded-sm" style="background: hsl(var(--color-up))" />
        税前股息率 ≥ {{ formatPercent(thresholds.green_threshold ?? 0) }}（红）
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-3 w-3 rounded-sm" style="background: hsl(var(--color-down))" />
        股息率 ≤ {{ formatPercent(thresholds.red_threshold ?? 0) }}（绿）
      </span>
    </p>
  </div>
</template>
