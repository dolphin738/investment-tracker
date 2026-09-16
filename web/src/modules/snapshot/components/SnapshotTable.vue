<script setup lang="ts">
/**
 * modules/snapshot/components/SnapshotTable.vue — 快照列表表格区域（平移自 SnapshotList.vue）
 *
 * 渲染 loading（骨架）/ error / empty 三态与 <Table>（日期/总资产/持仓/现金/来源/
 * 系统自动值+差异/备注/操作列）。数据由门面 SnapshotList 以 props 传入；
 * useSnapshots 等数据拉取保留在门面，本组件不发起任何请求（避免挂载死锁）。
 *
 * 仅承载行展示所需的纯函数（systemValOf / diffRateOf，随模板一并平移）；
 * 编辑 / 删除 / 重置交互经 emit 上抛，由门面既有处理函数承接。
 * 纯位置拆分：文案、类名、绑定与拆分前逐字节等价。
 */

import type { FormatCurrencyOptions } from '@/lib/utils';
import {
  formatAmountChange,
  formatCurrency,
  formatDate,
} from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pencil, RotateCcw, Trash2 } from 'lucide-vue-next';
import type { SnapshotResponse } from '@/api/types';

const props = defineProps<{
  /** 当前页快照列表 */
  items: SnapshotResponse[];
  isLoading: boolean;
  isError: boolean;
  /** 空数据文案（来自门面 emptyText prop 默认「暂无资产记录」） */
  emptyText: string;
  /** 金额格式偏好（千分位 / 缩写，门面自 preference store 读取） */
  fmtOpts: FormatCurrencyOptions;
}>();

const emit = defineEmits<{
  /** 点击编辑（页面打开 SnapshotForm 弹窗） */
  edit: [item: SnapshotResponse];
  /** 行内删除 → 门面置 deleting 打开确认弹窗 */
  delete: [item: SnapshotResponse];
  /** 行内重置（仅手工行）→ 门面置 resetting 打开确认弹窗 */
  reset: [item: SnapshotResponse];
}>();

/** 系统自动计算值（AL-054 · Q-1甲）：直接读列表行内 derivedTotalAsset（后端已实时回填） */
function systemValOf(s: SnapshotResponse): number | null {
  if (s.derivedTotalAsset == null) return null;
  const n = Number(s.derivedTotalAsset);
  return Number.isFinite(n) ? n : null;
}

/** 行差异率（仅手工行且有系统值时计算） */
function diffRateOf(s: SnapshotResponse): number | null {
  const manual = s.source === 'MANUAL';
  const systemVal = systemValOf(s);
  const totalAssetNum = Number(s.totalAsset) || 0;
  return manual && systemVal !== null && systemVal !== 0
    ? (totalAssetNum - systemVal) / systemVal
    : null;
}
</script>

<template>
  <div v-if="isLoading" class="space-y-2">
    <Skeleton v-for="i in 5" :key="i" class="h-12 w-full" />
  </div>
  <div v-else-if="isError" class="py-10 text-center text-sm text-muted-foreground">
    加载失败，请稍后重试
  </div>
  <div v-else-if="items.length === 0" class="py-10 text-center text-sm text-muted-foreground">
    {{ emptyText }}
  </div>
  <div v-else class="overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead class="sticky left-0 z-10 w-[100px] bg-background">日期</TableHead>
          <TableHead class="text-right">总资产</TableHead>
          <TableHead class="text-right">持仓</TableHead>
          <TableHead class="text-right">现金</TableHead>
          <TableHead class="w-[90px]">来源</TableHead>
          <TableHead>系统自动值（差异）</TableHead>
          <TableHead class="w-[110px]">备注</TableHead>
          <TableHead class="w-[110px] text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="s in items" :key="s.id">
          <TableCell class="sticky left-0 z-10 whitespace-nowrap bg-background font-mono text-sm tabular-nums">
            {{ formatDate(s.date) }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-right font-mono tabular-nums">
            {{ formatCurrency(s.totalAsset, 2, fmtOpts) }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-right font-mono text-sm tabular-nums">
            {{ s.marketValue !== null ? formatCurrency(s.marketValue, 2, fmtOpts) : '-' }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-right font-mono text-sm tabular-nums">
            {{ s.cashBalance !== null ? formatCurrency(s.cashBalance, 2, fmtOpts) : '-' }}
          </TableCell>
          <TableCell>
            <Badge
              v-if="s.source === 'MANUAL'"
              variant="secondary"
              class="bg-up-soft text-up"
            >
              手工
            </Badge>
            <Badge v-else variant="outline">自动</Badge>
          </TableCell>
          <TableCell class="text-sm">
            <template v-if="s.source === 'MANUAL'">
              <span v-if="systemValOf(s) !== null" class="text-muted-foreground">
                系统 {{ formatCurrency(systemValOf(s)!, 2, fmtOpts) }}
                <span
                  :class="
                    diffRateOf(s) !== null && diffRateOf(s)! >= 0
                      ? 'ml-1 text-up'
                      : 'ml-1 text-down'
                  "
                >
                  （{{
                    diffRateOf(s) !== null
                      ? formatAmountChange(Number(s.totalAsset) || 0, systemValOf(s)!, 2, fmtOpts)
                      : '-'
                  }}）
                </span>
              </span>
              <span v-else class="text-muted-foreground">-</span>
            </template>
            <span v-else class="text-xs text-muted-foreground">系统计算</span>
          </TableCell>
          <TableCell class="max-w-[100px] truncate text-sm text-muted-foreground">
            {{ s.note || '-' }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-right">
            <div class="flex justify-end gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                title="编辑（变手工）"
                @click="emit('edit', s)"
              >
                <Pencil class="h-4 w-4" />
              </Button>
              <Button
                v-if="s.source === 'MANUAL'"
                size="icon"
                variant="ghost"
                title="重置为系统自动值"
                @click="emit('reset', s)"
              >
                <RotateCcw class="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="删除"
                @click="emit('delete', s)"
              >
                <Trash2 class="h-4 w-4 text-red-500" />
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
