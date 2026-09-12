<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendInitBlock.vue — 全局设置「股息率」TAB 的「初始化」功能块
 *
 * 承载冷启动 / 数据修复用的手工动作（从「股息率排名」页迁出的 admin 触发按钮，
 * 外加新增的「回补行情缺口」）：
 * - 全量重建：useRebuildDividendYield()，无二次确认
 * - 特别分红回补：useBackfillSpecialDividends()，带二次确认 AlertDialog（文案照搬 RankingPage）
 * - 回补行情缺口：useBackfillDividendPrices()，带二次确认 AlertDialog
 *
 * 「历史行情回补接口」下拉留在父组件（绑定 settingsForm、参与 settings 保存），
 * 本组件仅接收其当前选择值（backfillInterfaceId）用于「回补行情缺口」按钮的禁用判断；
 * 「回补起始日期」为独立本地 ref，不参与 settings 保存，默认一年前的今天（ISO）。
 */
import { computed, ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2 } from 'lucide-vue-next';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';
import {
  useRebuildDividendYield,
  useBackfillSpecialDividends,
  useBackfillDividendPrices,
} from '@/modules/dividend-yield/composables/use-dividend-yield';

const props = defineProps<{
  /** 历史行情回补接口当前选择值（父组件 settingsForm 持有，用于「回补行情缺口」禁用判断） */
  backfillInterfaceId: string;
  /** 每日回补额度（只/天），由父组件 settingsForm 持有，本组件仅渲染输入并回传 */
  priceBackfillQuota: string;
  /** 在途回补任务目标起始日（YYYY-MM-DD）；null/undefined = 无在途任务；
   *  由父组件传入 dividendSettings?.price_backfill_start_date */
  priceBackfillStartDate: string | null;
}>();

/** 仅回传额度输入值（v-model 风格），其余状态仍由父组件 settingsForm 统一管理 */
const emit = defineEmits<{
  (e: 'update:priceBackfillQuota', v: string): void;
}>();

/** 回补起始日期：默认一年前的今天（ISO YYYY-MM-DD） */
function oneYearAgoIso(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}
const backfillStartDate = ref(oneYearAgoIso());

// ── 全量重建（无二次确认） ──
const rebuild = useRebuildDividendYield();
const rebuilding = computed(() => rebuild.isPending.value);
function onRebuild(): void {
  rebuild.mutate();
}

// ── 特别分红回补（二次确认） ──
const backfill = useBackfillSpecialDividends();
const backfilling = computed(() => backfill.isPending.value);
const backfillConfirmOpen = ref(false);
function onBackfill(): void {
  backfillConfirmOpen.value = true;
}
function confirmBackfill(): void {
  backfillConfirmOpen.value = false;
  backfill.mutate();
}

// ── 回补行情缺口（二次确认；未选接口或未填日期时禁用） ──
const backfillPrices = useBackfillDividendPrices();
const backfillingPrices = computed(() => backfillPrices.isPending.value);
const pricesConfirmOpen = ref(false);
const canBackfillPrices = computed(
  () =>
    props.backfillInterfaceId !== SELECT_EMPTY_VALUE &&
    props.backfillInterfaceId !== '' &&
    backfillStartDate.value.trim() !== '',
);
function onBackfillPrices(): void {
  if (!canBackfillPrices.value) return;
  pricesConfirmOpen.value = true;
}
function confirmBackfillPrices(): void {
  pricesConfirmOpen.value = false;
  backfillPrices.mutate(backfillStartDate.value);
}
</script>

<template>
  <div class="space-y-4">
    <!-- 在途回补任务状态：目标起始日非空 = 有跨日在途任务（服务端管理，前端只读展示） -->
    <p
      v-if="priceBackfillStartDate"
      class="text-xs font-medium text-amber-600"
    >
      回补进行中（目标起始日 {{ priceBackfillStartDate }}）：每日收盘价抓取后按额度自动续跑，全部补完自动结束
    </p>

    <!-- 每日回补额度（只/天）：参与父组件 settings 保存，本组件仅渲染输入并回传 -->
    <div class="space-y-2">
      <Label for="dy-price-backfill-quota">每日回补额度（只/天）</Label>
      <Input
        id="dy-price-backfill-quota"
        :model-value="priceBackfillQuota"
        type="number"
        min="1"
        max="2000"
        @update:model-value="(v) => emit('update:priceBackfillQuota', String(v))"
      />
      <p class="text-xs text-muted-foreground">
        每日收盘价抓取后按该额度自动续跑，补完自动停止
      </p>
    </div>

    <!-- 回补起始日期（独立本地值，不参与 settings 保存） -->
    <div class="space-y-2">
      <Label for="dy-backfill-start">回补起始日期</Label>
      <Input
        id="dy-backfill-start"
        v-model="backfillStartDate"
        type="date"
        class="w-full"
      />
    </div>

    <!-- 三个初始化按钮（均带 loading 态与 disabled 联动） -->
    <div class="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        :disabled="rebuilding"
        @click="onRebuild"
      >
        <Loader2 v-if="rebuilding" class="mr-2 h-4 w-4 animate-spin" />
        全量重建
      </Button>

      <Button
        variant="outline"
        :disabled="backfilling"
        title="冷启动一次性：补齐 5 年特别分红（须在季度抓取之后执行）"
        @click="onBackfill"
      >
        <Loader2 v-if="backfilling" class="mr-2 h-4 w-4 animate-spin" />
        特别分红回补
      </Button>

      <Button
        variant="outline"
        :disabled="!canBackfillPrices || backfillingPrices"
        title="启动跨日回补任务：立即处理第一批，之后每日收盘价抓取后按额度自动续跑，补完自动结束；中途被熔断次日自动接着跑"
        @click="onBackfillPrices"
      >
        <Loader2 v-if="backfillingPrices" class="mr-2 h-4 w-4 animate-spin" />
        回补行情缺口
      </Button>
    </div>

    <!-- 特别分红回补二次确认（文案照搬 RankingPage） -->
    <AlertDialog
      :open="backfillConfirmOpen"
      @update:open="(o) => !o && (backfillConfirmOpen = false)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认触发特别分红回补？</AlertDialogTitle>
          <AlertDialogDescription>
            将串行回补近 5 年特别分红（约 12~25 分钟写库），属冷启动一次性操作，且须在季度抓取之后执行。进度可在「定时任务日志」查看。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="backfilling">取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="backfilling"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmBackfill"
          >
            <Loader2 v-if="backfilling" class="mr-2 h-4 w-4 animate-spin" />
            确认回补
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 回补行情缺口二次确认 -->
    <AlertDialog
      :open="pricesConfirmOpen"
      @update:open="(o) => !o && (pricesConfirmOpen = false)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认启动跨日行情回补任务？</AlertDialogTitle>
          <AlertDialogDescription>
            将启动跨日回补任务：立即处理第一批，之后每日收盘价抓取后按额度自动续跑，全部补完自动结束。受数据源限速与日请求量限制，全量约需数天。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="backfillingPrices">取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="backfillingPrices"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmBackfillPrices"
          >
            <Loader2 v-if="backfillingPrices" class="mr-2 h-4 w-4 animate-spin" />
            确认回补
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
