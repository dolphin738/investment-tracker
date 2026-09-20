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
  useSeedInitialDividends,
} from '@/modules/dividend-yield/composables/use-dividend-yield';

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
        title="一次性补齐全市场近 5 年历史分红（约 19 小时，可断点续跑）"
        @click="onSeed"
      >
        <Loader2 v-if="seeding" class="mr-2 h-4 w-4 animate-spin" />
        补齐历史分红
      </Button>
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
            将串行拉取全市场约 11430 只证券近 5 年的历史分红（接口限流 10/min，约 19 小时），属一次性补齐操作，支持断点续跑；进度可在「定时任务日志」查看。
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
  </div>
</template>
