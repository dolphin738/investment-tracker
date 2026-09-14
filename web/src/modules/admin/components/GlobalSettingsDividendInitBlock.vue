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
 * 「回补起始日期」绑定父组件 settingsForm（v-model:default-start-date），随设置保存、
 * 触发回补以其为起点；在途任务存在时禁用并只读展示在途起点（改起点须先取消在途回补）。
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
  useCancelPriceBackfill,
} from '@/modules/dividend-yield/composables/use-dividend-yield';

const props = defineProps<{
  /** 历史行情回补接口当前选择值（父组件 settingsForm 持有，用于「回补行情缺口」禁用判断） */
  backfillInterfaceId: string;
  /** 每日回补额度（只/天），由父组件 settingsForm 持有，本组件仅渲染输入并回传 */
  priceBackfillQuota: string;
  /** 回补起始日期配置默认值（YYYY-MM-DD）：随设置保存、触发回补以其为起点；
   *  由父组件 settingsForm 持有，本组件仅渲染输入并 v-model 回传 */
  priceBackfillDefaultStartDate: string;
  /** 在途回补任务目标起始日（YYYY-MM-DD）；非空 = 有在途任务，禁用起点输入与触发；
   *  由父组件传入 dividendSettings?.price_backfill_start_date（服务端管理，只读） */
  priceBackfillInFlightDate: string | null;
  /** 当日已用回补额度（只）：后端已按自然日归零，用于剩余额度计算与「今日已用 X/N」 */
  priceBackfillUsedToday: number;
  /** 最近一次回补失败原因（熔断/接口不可达）；非空 = 最近一次在途回补以失败告终，红字展示 */
  priceBackfillLastError: string | null;
}>();

// 额度 / 回补起始日期 / 交易日历起始日期的输入框已上移至父组件
// GlobalSettingsDividendInitSection 的 2×2 网格（统一布局），本组件只保留数值计算与动作按钮。

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
/** 每日额度（数值）：父组件持有的是字符串输入值，此处取数值用于剩余额度计算 */
const quotaNum = computed(() => Number(props.priceBackfillQuota) || 0);
/** 当日剩余额度：额度按**自然日**消耗，任何触发方式共享同一份额度 */
const quotaRemaining = computed(() =>
  Math.max(0, quotaNum.value - props.priceBackfillUsedToday),
);
/** 当日额度已用尽 → 触发会 400，故按钮置灰并说明 */
const quotaExhausted = computed(() => quotaNum.value > 0 && quotaRemaining.value <= 0);

const canBackfillPrices = computed(
  () =>
    props.backfillInterfaceId !== SELECT_EMPTY_VALUE &&
    props.backfillInterfaceId !== '' &&
    props.priceBackfillDefaultStartDate.trim() !== '' &&
    // 已有在途任务 → 不可再启动（前端置灰只是 UX 层，后端 /backfill-prices 另有 400 护栏，
    // 挡多标签页/多管理员/直接 curl 的绕过）
    !props.priceBackfillInFlightDate &&
    !quotaExhausted.value,
);
function onBackfillPrices(): void {
  if (!canBackfillPrices.value) return;
  pricesConfirmOpen.value = true;
}
function confirmBackfillPrices(): void {
  pricesConfirmOpen.value = false;
  backfillPrices.mutate(props.priceBackfillDefaultStartDate);
}

// ── 取消在途回补（与「在途时禁止启动」成对：只禁不给退路会把人锁死） ──
const cancelPrices = useCancelPriceBackfill();
const cancellingPrices = computed(() => cancelPrices.isPending.value);
const cancelPricesConfirmOpen = ref(false);
function onCancelPrices(): void {
  cancelPricesConfirmOpen.value = true;
}
function confirmCancelPrices(): void {
  cancelPricesConfirmOpen.value = false;
  cancelPrices.mutate();
}
</script>

<template>
  <div class="space-y-4">
    <!-- 在途回补任务状态：目标起始日非空 = 有跨日在途任务（服务端管理，前端只读展示） -->
    <p
      v-if="priceBackfillInFlightDate"
      class="text-xs font-medium text-amber-600"
    >
      回补进行中（目标起始日 {{ priceBackfillInFlightDate }}）：每日收盘价抓取后按额度自动续跑，全部补完自动结束
    </p>
    <p
      v-if="priceBackfillLastError"
      class="text-xs font-medium text-red-600"
    >
      回补失败：{{ priceBackfillLastError }}
    </p>

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
        :title="
          quotaExhausted
            ? '今日回补额度已用尽（已用 ' +
              priceBackfillUsedToday +
              '/' +
              quotaNum +
              ' 只）：额度按自然日重置，请明日再触发'
            : priceBackfillInFlightDate
              ? '已有在途回补任务（起点 ' +
                priceBackfillInFlightDate +
                '）：须等其完成，或先点「取消在途回补」'
              : '启动跨日回补任务：立即处理第一批，之后每日收盘价抓取后按剩余额度自动续跑，补完自动结束；中途被熔断次日自动接着跑'
        "
        @click="onBackfillPrices"
      >
        <Loader2 v-if="backfillingPrices" class="mr-2 h-4 w-4 animate-spin" />
        {{
          quotaExhausted
            ? '今日额度已用尽'
            : priceBackfillInFlightDate
              ? '回补进行中…'
              : '回补行情缺口'
        }}
      </Button>

      <Button
        v-if="priceBackfillInFlightDate"
        variant="outline"
        :disabled="cancellingPrices"
        title="取消在途回补：正在抓取的这一只会跑完，随后立即停止且不再续跑，已补数据保留"
        @click="onCancelPrices"
      >
        <Loader2 v-if="cancellingPrices" class="mr-2 h-4 w-4 animate-spin" />
        取消在途回补
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

    <!-- 取消在途回补二次确认（协作式取消：当前一只跑完即停，不再等整批） -->
    <AlertDialog
      :open="cancelPricesConfirmOpen"
      @update:open="(o) => !o && (cancelPricesConfirmOpen = false)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认取消在途回补？</AlertDialogTitle>
          <AlertDialogDescription>
            将清除在途标记（起点 {{ priceBackfillInFlightDate }}）。正在抓取的这一只会跑完、随后立即停止，剩余证券不再抓取；此后每日收盘价抓取不再续跑。已补的数据一律保留，可随时用新起点重新触发。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="cancellingPrices">取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="cancellingPrices"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmCancelPrices"
          >
            <Loader2 v-if="cancellingPrices" class="mr-2 h-4 w-4 animate-spin" />
            确认取消
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
