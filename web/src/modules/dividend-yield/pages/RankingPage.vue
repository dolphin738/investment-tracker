<script setup lang="ts">
/**
 * modules/dividend-yield/pages/RankingPage.vue — 管理页（§10.2）
 *
 * 全部榜单管理视图：§8.1 过滤条（交易所/口径/连续年数下限/含预案/两年无分红，默认剔除
 * 近两年无分红）+ 列头排序（后端白名单五列，口径列 TTM 优先固定序）+ 分页 + 覆盖度计数；
 * include_proposed=false 时服务端现算「过滤态股息率」（行内 filtered 徽标）。
 * 行点击 → 详情弹窗（曲线 + 反推价格，与 TopPage 共用 SecurityDetailPanel，
 * 经 SecurityDetailDialog 模态包装；关闭后返回榜单列表状态）。
 * 支持 URL query 初始化过滤（§10.3 TopPage「查看全部」带 min_consecutive 跳入）。
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import Pagination from '@/components/common/Pagination.vue';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatPercent, formatCurrency } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import { useRank, useRebuildDividendYield } from '../composables/use-dividend-yield';
import { useYieldThresholds } from '../composables/use-yield-thresholds';
import SecurityDetailDialog from '../components/SecurityDetailDialog.vue';
import type { DividendYieldSort } from '@/api/types';

const route = useRoute();
const isAdmin = computed(() => useIsAdmin());
const { thresholds, yieldClass } = useYieldThresholds(() => useIsAdmin());

// ── 过滤 / 排序 / 分页状态 ──
const allPage = ref(1);
const allPageSize = ref(20);
const allSort = ref<DividendYieldSort>('dividend_yield');
const fExchange = ref<string>('ALL');
const fMode = ref<string>('ALL');
const fMinConsecutive = ref<string>(
  typeof route.query.min_consecutive === 'string' ? route.query.min_consecutive : '',
);
const fIncludeProposed = ref(true);
const fIncludeNoDividend = ref(false);

const rankFilters = computed(() => ({
  exchange: fExchange.value === 'ALL' ? undefined : fExchange.value,
  mode: fMode.value === 'ALL' ? undefined : (fMode.value as 'TTM' | 'LFY'),
  min_consecutive:
    fMinConsecutive.value.trim() === '' || Number.isNaN(Number(fMinConsecutive.value))
      ? undefined
      : Math.max(0, Math.floor(Number(fMinConsecutive.value))),
  include_proposed: fIncludeProposed.value,
  include_no_dividend: fIncludeNoDividend.value,
}));
// 过滤条件变化后回到第一页，避免落在越界页
watch(rankFilters, () => {
  allPage.value = 1;
});

const allRank = useRank(allPage, allPageSize, allSort, true, rankFilters);
const allItems = computed(() => allRank.data.value?.items ?? []);
/** 覆盖度计数（§1.3）：当前过滤口径下的公司总数 */
const allTotal = computed(() => allRank.data.value?.total ?? 0);
const allTotalPages = computed(() => Math.max(1, Math.ceil(allTotal.value / allPageSize.value)));

/** 列头点击排序（§8.1 五列，均降序 + NULLS LAST；口径列 TTM 优先固定序） */
const SORTABLE_COLUMNS: ReadonlyArray<{ key: DividendYieldSort; label: string }> = [
  { key: 'dividend_yield', label: '股息率（税前）' },
  { key: 'numerator_per_share', label: '每股分红' },
  { key: 'latest_price', label: '最新价' },
  { key: 'consecutive_years', label: '连续年数' },
  { key: 'mode', label: '口径' },
];
function sortBy(col: DividendYieldSort): void {
  allSort.value = col;
}
function isSorted(col: DividendYieldSort): boolean {
  return allSort.value === col;
}

/** 行点击 → 详情弹窗（默认不展示曲线图；关闭后清空选中返回榜单列表状态） */
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

function closeDetail(): void {
  selected.value = null;
}

function modeLabel(mode: 'TTM' | 'LFY'): string {
  return mode === 'TTM' ? 'TTM' : 'LFY';
}

/** 手动全量重建（admin-only；替代原系统定时任务） */
const rebuild = useRebuildDividendYield();
const rebuilding = computed(() => rebuild.isPending.value);
function onRebuild(): void {
  rebuild.mutate();
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="股息率排名"
      description="按 §8.1 过滤与排序浏览全部有分红记录公司；支持过滤态口径与阈值着色"
    />

    <!-- 过滤条（§8.1）：置于榜单框外，与持仓等页统一布局 -->
    <div class="flex flex-wrap items-end gap-4">
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">交易所</Label>
        <Select v-model="fExchange">
          <SelectTrigger class="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部</SelectItem>
            <SelectItem value="SH">上交所</SelectItem>
            <SelectItem value="SZ">深交所</SelectItem>
            <SelectItem value="BJ">北交所</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">口径</Label>
        <Select v-model="fMode">
          <SelectTrigger class="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部</SelectItem>
            <SelectItem value="TTM">TTM</SelectItem>
            <SelectItem value="LFY">LFY</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground" for="dy-min-cons">
          连续年数 ≥
        </Label>
        <Input
          id="dy-min-cons"
          v-model="fMinConsecutive"
          type="number"
          min="0"
          max="5"
          class="w-24"
          placeholder="不限"
        />
      </div>
      <div class="flex items-center gap-2 pb-1.5">
        <Switch id="dy-include-proposed" v-model="fIncludeProposed" />
        <Label for="dy-include-proposed" class="text-xs">含预案</Label>
      </div>
      <div class="flex items-center gap-2 pb-1.5">
        <Switch id="dy-include-no-div" v-model="fIncludeNoDividend" />
        <Label for="dy-include-no-div" class="text-xs">显示两年无分红</Label>
      </div>
      <Button
        v-if="isAdmin"
        variant="outline"
        size="sm"
        class="ml-auto self-end"
        :disabled="rebuilding"
        @click="onRebuild"
      >
        <Loader2 v-if="rebuilding" class="mr-1 h-4 w-4 animate-spin" />
        全量重建
      </Button>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">全部榜单</CardTitle>
        <CardDescription>
          覆盖 {{ allTotal }} 家（当前过滤口径）；含预案口径切换时服务端现算「过滤态股息率」
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <TableSkeleton v-if="allRank.isLoading.value" :rows="8" :cols="6" />
        <EmptyState
          v-else-if="allItems.length === 0"
          title="无符合条件的记录"
          description="尝试调整过滤条件（如打开「显示两年无分红」）"
        />
        <template v-else>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>代码 / 名称</TableHead>
                  <TableHead
                    v-for="col in SORTABLE_COLUMNS"
                    :key="col.key"
                    class="cursor-pointer text-right select-none"
                    :aria-sort="isSorted(col.key) ? 'descending' : 'none'"
                    @click="sortBy(col.key)"
                  >
                    {{ col.label }}
                    <span v-if="isSorted(col.key)" aria-hidden>↓</span>
                  </TableHead>
                  <TableHead>数据状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="item in allItems"
                  :key="item.master_id"
                  :class="cn(
                    item.stale ? 'opacity-60' : '',
                    'cursor-pointer',
                  )"
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
                  <TableCell
                    :class="cn(
                      'text-right font-mono tabular-nums',
                      yieldClass(item),
                    )"
                  >
                    {{ formatPercent(item.dividend_yield) }}
                  </TableCell>
                  <TableCell class="text-right font-mono tabular-nums">
                    {{ formatCurrency(item.numerator_per_share) }}
                  </TableCell>
                  <TableCell class="text-right font-mono tabular-nums">
                    {{ formatCurrency(item.latest_price) }}
                  </TableCell>
                  <TableCell class="text-right font-mono tabular-nums">
                    {{ item.consecutive_years ?? '-' }}
                  </TableCell>
                  <TableCell class="text-right">
                    <div class="flex flex-wrap items-center justify-end gap-1">
                      <Badge variant="outline">{{ modeLabel(item.mode) }}</Badge>
                      <Badge v-if="item.filtered" variant="secondary">过滤态</Badge>
                    </div>
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
          <Pagination
            :page="allPage"
            :total-pages="allTotalPages"
            :total="allTotal"
            :page-size="allPageSize"
            :page-size-options="[10, 20, 50, 100]"
            show-first-last
            show-jumper
            @page-change="(p: number) => (allPage = p)"
            @page-size-change="(s: number) => { allPageSize = s; allPage = 1; }"
          />
        </template>
      </CardContent>
    </Card>

    <!-- 证券详情弹窗（行点击弹出；默认不渲染，关闭后返回榜单列表状态） -->
    <SecurityDetailDialog :security="selected" @update:open="closeDetail" />

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
      <span v-if="!isAdmin">
        （阈值由管理员在「设置 → 股息率」配置）
      </span>
    </p>
  </div>
</template>
