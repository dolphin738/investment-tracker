<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendInitBlock.vue — 全局设置「股息率」TAB 的「初始化」功能块
 *
 * 承载冷启动 / 数据修复用的手工动作（从「股息率排名」页迁出的 admin 触发按钮）：
 * - 全量重建：useRebuildDividendYield()，无二次确认
 * - 补齐历史分红（播种）：useSeedInitialDividends()，带二次确认 AlertDialog
 *
 * 命名口径：内部机制仍称「播种 / seed」（与后端 handler、日志术语一致），
 * 而面向用户的 UI 文案一律用「补齐历史分红」，不出现「播种」等技术黑话。
 *
 * 注：同 Block 的「全量重建」按钮无二次确认，而播种需串行跑约 19 小时（属重操作），
 * 故此处保留 AlertDialog 二次确认结构，只改文案与事件流。
 *
 * 注：「回补行情缺口」及其「取消在途回补」按钮（原价格缺口回补后端端点）已随价格缺口回补
 * 功能下线一并移除，本组件不再承载任何在途轮询 / 额度展示逻辑。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
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
import { ROUTE_PATH } from '@/lib/constants';
import { useIsAdmin } from '@/stores/auth.store';
import {
  useRebuildDividendYield,
  useSeedInitialDividends,
  useSeedProgress,
  useCancelSeed,
} from '@/modules/dividend-yield/composables/use-dividend-yield';
import { usePendingDividendSummary } from '@/modules/dividend-yield/composables/use-pending-dividends';

const router = useRouter();
const isAdmin = useIsAdmin();

// ── 全量重建（无二次确认） ──
const rebuild = useRebuildDividendYield();
const rebuilding = computed(() => rebuild.isPending.value);
function onRebuild(): void {
  rebuild.mutate();
}

// ── 补齐历史分红 / 播种（二次确认：全市场约 19 小时，属重操作，必须确认） ──
const seed = useSeedInitialDividends();
const seeding = computed(() => seed.isPending.value);
const seedConfirmOpen = ref(false);
function onSeed(): void {
  seedConfirmOpen.value = true;
}
function confirmSeed(): void {
  seedConfirmOpen.value = false;
  seed.mutate();
}

// ── 补齐历史分红进度可视化（仅 admin；running 态由 composable 内部轮询） ──
const progress = useSeedProgress(isAdmin);
const progressData = computed(() => progress.data.value ?? null);
const progressStateLabel = computed(() => {
  const s = progressData.value?.state;
  return s === 'running' ? '运行中' : s === 'done' ? '已完成'
    : s === 'error' ? '失败' : s === 'cancelled' ? '已取消' : '空闲';
});

// ── 取消在途补齐（仅 admin；running 态可取消，已完成部分保留、可续跑） ──
const cancel = useCancelSeed();
const cancelling = computed(() => cancel.isPending.value);
const cancelConfirmOpen = ref(false);
function onCancel(): void {
  cancelConfirmOpen.value = true;
}
function confirmCancel(): void {
  cancelConfirmOpen.value = false;
  cancel.mutate();
}
const progressPercent = computed(() => {
  const p = progressData.value;
  if (!p || !p.total) return 0;
  return Math.min(100, Math.round((p.processed / p.total) * 100));
});

// ── 失败证券清单展开开关（仅当 failed > 0 时渲染入口） ──
const failedExpanded = ref(false);

// ── 待人工划分入口（仅 admin；非授权不发请求，staleTime 30s） ──
const summary = usePendingDividendSummary(isAdmin);
const summaryLoading = computed(() => summary.isLoading.value);
const pendingCount = computed(() => summary.data.value?.pending ?? 0);
function goPending(): void {
  router.push(ROUTE_PATH.ADMIN_PENDING_DIVIDENDS);
}
</script>

<template>
  <div class="space-y-4">
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
        :disabled="seeding"
        title="一次性补齐沪深京 A股近 5 年历史分红（约 10 小时，可断点续跑，运行中可取消）"
        @click="onSeed"
      >
        <Loader2 v-if="seeding" class="mr-2 h-4 w-4 animate-spin" />
        补齐历史分红
      </Button>

      <!-- 待人工划分入口（仅 admin；加载中不渲染；空态置灰不隐藏） -->
      <Button
        v-if="isAdmin && !summaryLoading"
        variant="outline"
        :disabled="pendingCount === 0"
        :title="
          pendingCount > 0
            ? `有 ${pendingCount} 笔无报告期分红待人工划分`
            : '当前无待划分分红'
        "
        @click="goPending"
      >
        {{ pendingCount > 0 ? `待人工划分 ${pendingCount} 笔 →` : '暂无待划分' }}
      </Button>
    </div>

    <!-- 补齐历史分红进度可视化：running/done/error 态展示；idle 不渲染 -->
    <div
      v-if="progressData && progressData.state !== 'idle'"
      class="rounded-md border border-border bg-muted/30 p-3 text-sm"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="font-medium">
          {{
            progressData.state === 'running'
              ? '补齐历史分红进行中'
              : progressData.state === 'done'
                ? '补齐历史分红完成'
                : progressData.state === 'cancelled'
                  ? '补齐历史分红已取消'
                  : '补齐历史分红失败'
          }}
        </span>
        <span
          class="rounded px-2 py-0.5 text-xs"
          :class="
            progressData.state === 'running'
              ? 'bg-blue-500/15 text-blue-400'
              : progressData.state === 'done'
                ? 'bg-green-500/15 text-green-400'
                : progressData.state === 'cancelled'
                  ? 'bg-amber-500/15 text-amber-400'
                  : 'bg-destructive/15 text-destructive'
          "
        >
          {{ progressStateLabel }}
        </span>
        <Button
          v-if="progressData.state === 'running'"
          variant="ghost"
          size="sm"
          class="h-7 text-xs text-muted-foreground hover:text-destructive"
          :disabled="cancelling"
          @click="onCancel"
        >
          <Loader2 v-if="cancelling" class="mr-1 h-3 w-3 animate-spin" />
          取消
        </Button>
      </div>

      <!-- 进度条（已处理 / 全表） -->
      <div class="mb-2 h-2 w-full overflow-hidden rounded bg-muted">
        <div
          class="h-full bg-primary transition-all"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>

      <div
        class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4"
      >
        <div>
          已处理
          <span class="text-foreground">{{ progressData.processed }} / {{ progressData.total }}</span>
        </div>
        <div>本轮处理 <span class="text-foreground">{{ progressData.hits }}</span></div>
        <div>已覆盖跳过 <span class="text-foreground">{{ progressData.covered }}</span></div>
        <div>
          失败 <span class="text-destructive">{{ progressData.failed }}</span>
        </div>
      </div>

      <!-- 失败证券清单：仅当 failed > 0 时渲染入口，支持展开查看「代码 + 名称」 -->
      <div
        v-if="progressData.failed > 0"
        class="mt-2"
      >
        <button
          type="button"
          class="flex items-center gap-1 text-xs text-destructive hover:underline"
          @click="failedExpanded = !failedExpanded"
        >
          <span>{{ failedExpanded ? '▾' : '▸' }}</span>
          <span>查看失败证券（{{ progressData.failed }} 只）</span>
        </button>
        <div
          v-if="failedExpanded"
          class="mt-1 max-h-40 overflow-y-auto rounded border border-destructive/30 bg-destructive/5 p-2"
        >
          <p
            v-if="progressData.failed_truncated"
            class="mb-1 text-[11px] text-muted-foreground"
          >
            仅显示前 {{ progressData.failed_securities.length }} 只，失败共 {{ progressData.failed }} 只（清单上限 _FAILED_IDS_CAP）。
          </p>
          <ul class="space-y-0.5 text-[11px] text-muted-foreground">
            <li
              v-for="sec in progressData.failed_securities"
              :key="sec.master_id"
              class="break-all"
              :title="`master_id: ${sec.master_id}`"
            >
              <span class="font-mono text-foreground">{{ sec.code }}</span>
              <span class="mx-1 text-muted-foreground">·</span>
              <span>{{ sec.name || '（无名）' }}</span>
            </li>
          </ul>
        </div>
      </div>

      <p
        v-if="progressData.state === 'error' && progressData.error"
        class="mt-2 text-xs text-destructive"
      >
        错误：{{ progressData.error }}
      </p>
      <p
        v-else-if="progressData.state === 'cancelled' && progressData.message"
        class="mt-2 text-xs text-amber-400"
      >
        {{ progressData.message }}
      </p>
      <p
        v-else-if="progressData.state === 'done' && progressData.message"
        class="mt-2 text-xs text-muted-foreground"
      >
        {{ progressData.message }}
      </p>
    </div>

    <!-- 补齐历史分红二次确认（约 19 小时的重操作，必须确认） -->
    <AlertDialog
      :open="seedConfirmOpen"
      @update:open="(o) => !o && (seedConfirmOpen = false)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认补齐历史分红？</AlertDialogTitle>
          <AlertDialogDescription>
            将串行拉取沪深京 A股（约 5900 只）近 5 年的历史分红（巨潮仅覆盖沪深京，接口限流 10/min，约 10 小时），属一次性补齐操作，支持断点续跑，运行中可随时取消（已完成部分保留）；进度见下方面板。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="seeding">取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="seeding"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmSeed"
          >
            <Loader2 v-if="seeding" class="mr-2 h-4 w-4 animate-spin" />
            确认补齐
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 取消在途补齐二次确认（已完成部分保留，可再次触发续跑） -->
    <AlertDialog
      :open="cancelConfirmOpen"
      @update:open="(o) => !o && (cancelConfirmOpen = false)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>取消补齐历史分红？</AlertDialogTitle>
          <AlertDialogDescription>
            任务将在下一个中断点停止，已补齐的证券保留（按「当前明细源 + 近 5 年」判定为已覆盖），可再次触发从断点续跑，不丢数据、不重复写入。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="cancelling">暂不取消</AlertDialogCancel>
          <AlertDialogAction
            :disabled="cancelling"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmCancel"
          >
            <Loader2 v-if="cancelling" class="mr-2 h-4 w-4 animate-spin" />
            确认取消
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
