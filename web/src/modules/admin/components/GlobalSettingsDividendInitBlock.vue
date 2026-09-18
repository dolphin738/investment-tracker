<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendInitBlock.vue — 全局设置「股息率」TAB 的「初始化」功能块
 *
 * 承载冷启动 / 数据修复用的手工动作（从「股息率排名」页迁出的 admin 触发按钮）：
 * - 全量重建：useRebuildDividendYield()，无二次确认
 * - 特别分红回补：useBackfillSpecialDividends()，带二次确认 AlertDialog（文案照搬 RankingPage）
 *
 * 注：「回补行情缺口」及其「取消在途回补」按钮（原价格缺口回补后端端点）已随价格缺口回补
 * 功能下线一并移除，本组件不再承载任何在途轮询 / 额度展示逻辑。
 */
import { computed, ref } from 'vue';
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
import {
  useRebuildDividendYield,
  useBackfillSpecialDividends,
} from '@/modules/dividend-yield/composables/use-dividend-yield';

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
        :disabled="backfilling"
        title="冷启动一次性：补齐 5 年特别分红（须在季度抓取之后执行）"
        @click="onBackfill"
      >
        <Loader2 v-if="backfilling" class="mr-2 h-4 w-4 animate-spin" />
        特别分红回补
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
  </div>
</template>
