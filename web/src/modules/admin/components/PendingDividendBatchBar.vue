<script setup lang="ts">
/**
 * modules/admin/components/PendingDividendBatchBar.vue — 批量操作条 + 结果红条（S17 自门面抽出）
 *
 * 纯展示：上一批结果（成功/失败笔数 + 前 5 条失败明细）与操作条（采纳建议 / 忽略 / 清空 +
 * 「已跳过 N 笔无候选行」说明）全部由门面下传，动作经事件上抛。门面因此不再内联这两段块。
 */
import { Button } from '@/components/ui/button';
import type { BatchFailedItem } from '@/modules/dividend-yield/lib/pending-dividends';

const props = defineProps<{
  /** 上一批成功笔数 */
  succeeded: number;
  /** 上一批失败明细（空数组 = 无失败，不渲染红条） */
  failed: BatchFailedItem[];
  /** 当前勾选笔数 */
  selectedCount: number;
  /** 勾选中「有建议候选」的笔数（采纳建议实际会提交的数量） */
  adoptableCount: number;
  /** 勾选中无候选、会被跳过的笔数 */
  skipped: number;
  /** 批量采纳提交中 */
  assignPending: boolean;
  /** 批量忽略提交中 */
  ignorePending: boolean;
  /** 是否管理员（非 admin 不渲染操作条） */
  isAdmin: boolean;
}>();

const emit = defineEmits<{
  (e: 'adopt'): void;
  (e: 'ignore'): void;
  (e: 'clear'): void;
}>();
</script>

<template>
  <!-- 批量结果红条（部分失败：列前 5 条；失败行由门面保持选中） -->
  <div
    v-if="props.failed.length > 0"
    class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
  >
    <div class="font-medium">
      上一批操作：成功 {{ props.succeeded }} 笔、失败 {{ props.failed.length }} 笔（失败行已保持选中）
    </div>
    <ul class="mt-1 list-inside list-disc text-xs">
      <li v-for="f in props.failed.slice(0, 5)" :key="f.id">
        {{ f.id }} — {{ f.code }}：{{ f.reason }}
      </li>
    </ul>
  </div>

  <!-- 批量操作条（sticky，非 fixed） -->
  <div
    v-if="props.isAdmin && props.selectedCount > 0"
    class="sticky bottom-0 z-30 flex flex-wrap items-center gap-3 rounded-md border bg-background/95 px-4 py-3 shadow-sm backdrop-blur"
  >
    <span class="text-sm">已选 {{ props.selectedCount }} 笔</span>
    <Button
      size="sm"
      :disabled="props.adoptableCount === 0 || props.assignPending"
      :title="props.skipped > 0 ? `已跳过 ${props.skipped} 笔无候选行` : ''"
      @click="emit('adopt')"
    >
      采纳建议 ({{ props.adoptableCount }})
    </Button>
    <Button
      variant="outline"
      size="sm"
      :disabled="props.ignorePending"
      @click="emit('ignore')"
    >
      忽略 ({{ props.selectedCount }})
    </Button>
    <Button variant="ghost" size="sm" class="ml-auto" @click="emit('clear')">
      清空
    </Button>
    <span v-if="props.skipped > 0" class="text-xs text-muted-foreground">
      （已跳过 {{ props.skipped }} 笔无候选行）
    </span>
  </div>
</template>
