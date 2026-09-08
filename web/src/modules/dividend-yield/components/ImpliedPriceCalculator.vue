<script setup lang="ts">
/**
 * modules/dividend-yield/components/ImpliedPriceCalculator.vue — 股息价格推算
 *
 * 自 SecurityDetailPanel 迁出的「反推价格」功能独立化（对外名「股息价格推算」，参照外部模板丰富界面）：
 * - 选择股票：搜索式选择框（UI 形态参考持仓页 SecuritySearchCombobox：搜索图标 +
 *   内联候选下拉 + 清空叉），候选 = 股息率榜单前 200 家（有分红记录，按股息率降序），
 *   本地按代码 / 名称即时过滤；选中后自动带出该股每股分红（榜单行
 *   numerator_per_share，服务端分红记录口径，只读展示）；
 * - 目标股息率以百分比输入（如 6 = 6%），内部换算小数后仍走原服务端
 *   implied-price 接口计算（保留原有逻辑与当前价/当前股息率对照）；
 * - 结果卡：每股分红 | 目标股息率 → 隐含价格大字 + 公式 + 「当前价 ≤ 隐含价时股息率 ≥ 目标」语义；
 * - 快速参考：基于当前每股分红按 3%~8% 六档本地折算的速查格（纯展示，不发起请求）；
 * - 目标股息率变化自动重新计算（原交互保留），「计算目标价格」按钮手动触发 refetch；
 * - 布局 grid 响应式，移动端单列堆叠。
 */
import { computed, ref } from 'vue';
import { Loader2, Search, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { useImpliedPrice, useRank } from '../composables/use-dividend-yield';
import type { DividendYieldRankItem } from '@/api/types';
import type { DividendYieldSort } from '@/api/types';

// ── 股票候选：榜单前 200（有分红记录，按股息率降序） ──
const CANDIDATE_PAGE_SIZE = 200;
const candidatePage = ref(1);
const candidateSort = ref<DividendYieldSort>('dividend_yield');
const candidatesQuery = useRank(
  candidatePage,
  CANDIDATE_PAGE_SIZE,
  candidateSort,
  true,
);
const candidates = computed<DividendYieldRankItem[]>(
  () => candidatesQuery.data.value?.items ?? [],
);

// ── 搜索式选择（本地过滤：代码 / 名称包含匹配，大小写不敏感） ──
const selected = ref<DividendYieldRankItem | null>(null);
const searchQuery = ref('');
const searchOpen = ref(false);

const searching = computed(() => searchQuery.value.trim().length > 0);

const filteredCandidates = computed<DividendYieldRankItem[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return candidates.value;
  return candidates.value.filter(
    (c) =>
      (c.code ?? '').toLowerCase().includes(q) ||
      (c.name ?? '').toLowerCase().includes(q),
  );
});

/** 选中项回显文本（非搜索态展示） */
const selectedLabel = computed(() =>
  selected.value
    ? `${selected.value.name || '未命名'}（${selected.value.code || '-'}）`
    : '',
);

function handlePick(item: DividendYieldRankItem): void {
  selected.value = item;
  searchQuery.value = '';
  searchOpen.value = false;
}

function handleClear(): void {
  selected.value = null;
  searchQuery.value = '';
  searchOpen.value = false;
}

/** 服务端权威每股分红（选中后优先用接口返回，回退榜单行值） */
const numeratorPerShare = computed<number | null>(() => {
  const fromApi = implied.data.value?.numerator_per_share;
  if (fromApi != null) return fromApi;
  return selected.value?.numerator_per_share ?? null;
});

// ── 目标股息率（百分比输入，内部换算小数比率） ──
const ratioPercent = ref<string>('');
const validRatio = computed<number | null>(() => {
  const t = ratioPercent.value.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n / 100;
});
const ratioError = computed<string | null>(() => {
  if (!ratioPercent.value.trim()) return null;
  return validRatio.value === null ? '须为 0 < 目标股息率 ≤ 100 的数值' : null;
});

// ── 隐含价格（服务端计算；逻辑与原 SecurityDetailPanel 反推区块一致） ──
const implied = useImpliedPrice(
  computed(() => selected.value?.master_id ?? null),
  validRatio,
  computed(() => selected.value != null),
);

/** 计算目标价格：手动触发一次重算（输入变化时仍会自动计算，保留原交互） */
const recalculating = ref(false);
async function onRecalculate(): Promise<void> {
  if (validRatio.value === null || !selected.value) return;
  recalculating.value = true;
  try {
    await implied.refetch();
  } finally {
    recalculating.value = false;
  }
}

const calculating = computed(
  () => implied.isLoading.value || implied.isFetching.value || recalculating.value,
);

// ── 快速参考：基于当前每股分红按 3%~8% 本地折算（纯展示） ──
const QUICK_RATIOS = [0.03, 0.04, 0.05, 0.06, 0.07, 0.08] as const;
const quickRefs = computed(() => {
  const n = numeratorPerShare.value;
  if (n == null || n <= 0) return [];
  return QUICK_RATIOS.map((r) => ({
    ratio: r,
    price: n / r,
  }));
});

// 点击候选时容器 blur 可能先触发；用 mousedown 阻止默认，保证 click 可命中
function handleContainerMousedown(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('[data-calc-candidate]')) {
    e.preventDefault();
  }
}

function handleBlur(): void {
  setTimeout(() => {
    searchOpen.value = false;
  }, 150);
}
</script>

<template>
  <div class="space-y-5">
    <!-- 选择股票（搜索式：候选 = 榜单前 200 有分红记录股票） -->
    <div class="space-y-1.5">
      <Label for="dy-calc-security" class="text-sm font-medium">选择股票</Label>
      <div class="relative" @mousedown="handleContainerMousedown">
        <div class="relative">
          <Search
            class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="dy-calc-security"
            class="pl-8 pr-8"
            placeholder="搜索代码 / 名称（候选为股息率榜单前 200 家）"
            :model-value="searching ? searchQuery : selectedLabel"
            @update:model-value="(v: string | number) => { searchQuery = String(v); searchOpen = true; }"
            @focus="() => { if (searchQuery) searchOpen = true; }"
            @blur="handleBlur"
          />
          <button
            v-if="(searching ? searchQuery : selectedLabel)"
            type="button"
            aria-label="清除"
            class="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            @click="handleClear"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- 搜索下拉候选 -->
        <div
          v-if="searchOpen"
          class="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <div
            v-if="candidatesQuery.isLoading.value"
            class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          >
            <Loader2 class="h-3.5 w-3.5 animate-spin" /> 候选加载中…
          </div>
          <p
            v-else-if="filteredCandidates.length === 0"
            class="px-3 py-2 text-sm text-muted-foreground"
          >
            无匹配结果
          </p>
          <template v-else>
            <button
              v-for="c in filteredCandidates"
              :key="c.master_id"
              type="button"
              data-calc-candidate
              class="flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              @click="handlePick(c)"
            >
              <span class="truncate">
                <span class="font-medium">{{ c.name || '未命名' }}</span>
                <span class="ml-2 font-mono text-xs text-muted-foreground">
                  {{ c.code || '-' }}
                </span>
              </span>
              <span class="shrink-0 text-xs text-muted-foreground">
                每股分红 {{ formatCurrency(c.numerator_per_share) }}
              </span>
            </button>
          </template>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        候选为有分红记录的股票（按股息率降序前 200 家）；选中后自动带出每股分红
      </p>
    </div>

    <!-- 每股分红（选中自动带出，只读） + 目标股息率 -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="space-y-1.5">
        <Label for="dy-calc-numerator" class="text-sm font-medium">
          每股分红（元/股）
        </Label>
        <Input
          id="dy-calc-numerator"
          :model-value="numeratorPerShare != null ? String(numeratorPerShare) : ''"
          placeholder="选中股票后自动带出"
          readonly
          class="bg-muted/50"
        />
        <p class="text-xs text-muted-foreground">
          取自服务端分红记录口径，选中股票后自动填入
        </p>
      </div>
      <div class="space-y-1.5">
        <Label for="dy-calc-ratio" class="text-sm font-medium">
          目标股息率（%）
        </Label>
        <Input
          id="dy-calc-ratio"
          v-model="ratioPercent"
          type="number"
          min="0"
          max="100"
          step="0.1"
          placeholder="如 6（即 6%）"
        />
        <p v-if="ratioError" class="text-xs text-red-500">{{ ratioError }}</p>
        <p v-else class="text-xs text-muted-foreground">
          输入后自动计算，也可点击下方按钮重新计算
        </p>
      </div>
    </div>

    <!-- 计算按钮（居中，模板样式） -->
    <div class="flex justify-center">
      <Button
        variant="ghost"
        class="text-primary hover:text-primary"
        :disabled="!selected || validRatio === null || calculating"
        @click="onRecalculate"
      >
        <Loader2 v-if="calculating" class="mr-1 h-4 w-4 animate-spin" />
        计算目标价格
      </Button>
    </div>

    <!-- 结果卡：隐含价格 + 公式 + 当前价对照 -->
    <div
      v-if="selected && validRatio !== null"
      class="space-y-2 rounded-lg border bg-primary/5 p-5 text-center"
    >
      <template v-if="calculating">
        <Skeleton class="mx-auto h-10 w-40" />
      </template>
      <template v-else-if="implied.data.value?.implied_price != null">
        <p class="text-sm text-muted-foreground">
          每股分红
          {{ formatCurrency(implied.data.value.numerator_per_share) }}
          ｜ 目标股息率
          {{ formatPercent(implied.data.value.target_ratio) }}
        </p>
        <p
          class="font-mono text-4xl font-bold tabular-nums text-primary"
          aria-label="隐含价格"
        >
          {{ formatCurrency(implied.data.value.implied_price) }}
        </p>
        <p class="text-xs text-muted-foreground">
          公式：
          {{ formatCurrency(implied.data.value.numerator_per_share) }}
          ÷
          {{ formatPercent(implied.data.value.target_ratio) }}
          =
          {{ formatCurrency(implied.data.value.implied_price) }}
        </p>
        <p class="text-xs text-muted-foreground">
          当股价 ≤
          {{ formatCurrency(implied.data.value.implied_price) }}
          时，股息率 ≥
          {{ formatPercent(implied.data.value.target_ratio) }}
        </p>
        <p
          v-if="implied.data.value.current_price != null"
          class="text-xs text-muted-foreground"
        >
          当前价
          {{ formatCurrency(implied.data.value.current_price) }}
          （当前股息率
          {{ formatPercent(implied.data.value.current_dividend_yield) }}）
        </p>
      </template>
      <p v-else class="text-sm text-muted-foreground">
        暂无法计算（该股票缺少分红数据）
      </p>
    </div>

    <!-- 快速参考：3%~8% 速查格 -->
    <div v-if="quickRefs.length > 0" class="space-y-2">
      <p class="text-sm font-medium">
        快速参考
        <span class="ml-1 text-xs font-normal text-muted-foreground">
          （基于当前每股分红
          {{ formatCurrency(numeratorPerShare) }}
          折算）
        </span>
      </p>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div
          v-for="q in quickRefs"
          :key="q.ratio"
          class="rounded-md border bg-muted/40 p-3 text-center"
        >
          <p class="text-sm font-medium text-primary">
            {{ Math.round(q.ratio * 100) }}%
          </p>
          <p class="mt-1 font-mono text-sm tabular-nums">
            {{ formatCurrency(q.price) }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
