<script setup lang="ts">
/**
 * modules/dividend-yield/components/ImpliedPriceCalculator.vue — 股息价格推算
 *
 * 自 SecurityDetailPanel 迁出的「反推价格」功能独立化（对外名「股息价格推算」，参照外部模板丰富界面）：
 * - 选择股票：SecuritySearchCombobox 搜索式选股（同持仓页，键入防抖搜索证券主数据，
 *   匹配代码 / 名称 / 拼音首字母）；证券主数据不含分红字段，每股分红在计算后
 *   由服务端 implied-price 接口带出（只读展示）；选中无分红记录的股票时结果区
 *   提示「暂无法计算」；
 * - 目标股息率以百分比输入（如 6 = 6%），内部换算小数后仍走原服务端
 *   implied-price 接口计算（保留原有逻辑与当前价/当前股息率对照）；
 * - 结果卡：每股分红 | 目标股息率 → 隐含价格大字 + 公式 + 「当前价 ≤ 隐含价时股息率 ≥ 目标」语义；
 * - 快速参考：基于当前每股分红按 3%~8% 六档本地折算的速查格（纯展示，不发起请求）；
 * - 目标股息率变化自动重新计算（原交互保留），「计算目标价格」按钮手动触发 refetch；
 * - 布局 grid 响应式，移动端单列堆叠。
 */
import { computed, ref } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import SecuritySearchCombobox from '@/components/common/SecuritySearchCombobox.vue';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { useImpliedPrice } from '../composables/use-dividend-yield';
import type { SecurityMaster } from '@/api/security-master.api';

// ── 选中股票（搜索式选择，同持仓页） ──
const selected = ref<SecurityMaster | null>(null);
const selectedLabel = computed(() =>
  selected.value
    ? `${selected.value.name || '未命名'}（${selected.value.code || '-'}）`
    : '',
);

function handleSelect(master: SecurityMaster): void {
  selected.value = master;
}

function handleClear(): void {
  selected.value = null;
}

/** 服务端权威每股分红（仅计算响应携带；证券主数据无分红字段） */
const numeratorPerShare = computed<number | null>(
  () => implied.data.value?.numerator_per_share ?? null,
);

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
  computed(() => selected.value?.id ?? null),
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
</script>

<template>
  <div class="space-y-5">
    <!-- 选择股票（搜索式，同持仓页） -->
    <div class="space-y-1.5">
      <Label for="dy-calc-security" class="text-sm font-medium">选择股票</Label>
      <SecuritySearchCombobox
        id="dy-calc-security"
        :value="selectedLabel"
        :on-select="handleSelect"
        :on-clear="handleClear"
        placeholder="搜索代码 / 名称 / 拼音首字母"
      />
      <p class="text-xs text-muted-foreground">
        搜索全市场证券；仅有分红记录的股票可完成推算
      </p>
    </div>

    <!-- 每股分红（计算后带出，只读） + 目标股息率 -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="space-y-1.5">
        <Label for="dy-calc-numerator" class="text-sm font-medium">
          每股分红（元/股）
        </Label>
        <Input
          id="dy-calc-numerator"
          :model-value="numeratorPerShare != null ? String(numeratorPerShare) : ''"
          placeholder="计算后自动带出"
          readonly
          class="bg-muted/50"
        />
        <p class="text-xs text-muted-foreground">
          取自服务端分红记录口径，计算后自动填入
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
        暂无法计算（该股票缺少分红记录）
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
