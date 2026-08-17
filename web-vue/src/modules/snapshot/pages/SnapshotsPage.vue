<script setup lang="ts">
/**
 * modules/snapshot/pages/SnapshotsPage.vue — 资产记录页（PRD §7.3）
 *
 * 平移自 React 版 web/src/pages/snapshots.tsx，行为契约一致：
 * - 列表：日期/总资产/持仓/现金/来源（自动/手工）/系统自动值+差异%/备注/操作
 * - 操作：编辑（变手工）、删除（事件日会重新生成自动值）、重置（仅手工记录）
 * - 新建/编辑弹窗：日期（不可未来）/总资产（必填）/持仓/现金/备注 + 系统自动值覆盖提示
 */

import { computed, ref } from 'vue';
import { Plus } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import SnapshotForm from '../components/SnapshotForm.vue';
import SnapshotList from '../components/SnapshotList.vue';
import { resolveQuickRange } from '@/modules/query/quick-range';
import { useDefaultDateRange } from '@/modules/query/use-default-date-range';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type { SnapshotQuery } from '@/api/types';
import type { AssetSnapshot } from '@/lib/types';

const portfolioStore = usePortfolioStore();
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
// 「全部」快捷项的起点 = 组合首个交易日（问题②）
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);

// I-04：默认日期范围 = 偏好（URL 无参数时），非法/空回落 '1y'；
// computed 保证偏好异步到达后默认范围同步生效（列表内对齐守卫依赖同一链路）
const defaultRange = useDefaultDateRange();
const defaultRangeValue = computed(() =>
  resolveQuickRange(defaultRange.value, {
    allRangeStart: baseDate.value ?? undefined,
  }),
);

// 列表 query：I-04 列表默认日期范围 = 偏好默认（无 URL 参数时）
const listQuery = computed<SnapshotQuery>(() => ({
  pageSize: 20,
  startDate: defaultRangeValue.value.startDate,
  endDate: defaultRangeValue.value.endDate,
}));

const createOpen = ref(false);
const editing = ref<AssetSnapshot | null>(null);

function handleEdit(item: AssetSnapshot): void {
  editing.value = item;
}
</script>

<template>
  <!-- 无组合：引导选择（对齐 React 条件渲染分支） -->
  <Card v-if="!currentPortfolioId" class="mx-auto max-w-md">
    <CardContent class="py-10 text-center text-sm text-muted-foreground">
      请先选择一个投资组合
    </CardContent>
  </Card>

  <div v-else class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">历史总资产记录</h1>
        <p class="text-sm text-muted-foreground">
          默认由系统每日自动记录；您也可手工补录或修正某日数值
        </p>
        <p class="text-sm text-muted-foreground">
          每天只保留一条记录：手工记录会取代当天的自动记录
        </p>
      </div>
      <div class="flex items-center gap-2">
        <!-- Gap D（SET-P0-03 同口径）：后端导出接口未实现，视觉占位禁用 -->
        <Button
          variant="outline"
          :size="ENTRY_BUTTON_SIZE"
          disabled
          title="v1 暂未开放（SET-P0-03）：导出接口待后端实现"
        >
          导出 CSV
        </Button>
        <!--
          INC-05：与概览页「录入买卖」同规格（主色 + sm + Plus 图标）。
          文案由「＋ 新建记录」改为字典值「录入资产记录」——
          字面「+」删除，加号语义由 Plus 图标承载（决策 H）。
        -->
        <Button
          :variant="ENTRY_BUTTON_VARIANT"
          :size="ENTRY_BUTTON_SIZE"
          @click="createOpen = true"
        >
          <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
          {{ ENTRY_BUTTON_LABELS.snapshot }}
        </Button>
      </div>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">历史记录</CardTitle>
        <CardDescription>
          来源「自动」= 系统按交易/余额推导；「手工」= 用户录入（可重置）
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SnapshotList
          :portfolio-id="currentPortfolioId"
          :query="listQuery"
          @edit="handleEdit"
        />
      </CardContent>
    </Card>

    <!-- 底部图例（§7.3） -->
    <div
      class="space-y-1 rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground"
    >
      <p>「沿用」= 当日无价格/现金更新，按前值沿用</p>
      <p>「按成本」= 存在无价格记录的标的，按成本价估值</p>
      <p>每天唯一一条记录；手工录入会取代该日自动记录</p>
      <p>「编辑」= 编辑该日记录（保存后该日变为手工记录）</p>
      <p>「删除」= 删除该日记录（事件日会被系统重新生成自动值）</p>
      <p>「重置」= 撤销手工修改、恢复系统计算值（仅手工记录可用）</p>
    </div>

    <!-- 新建弹窗 -->
    <Dialog :open="createOpen" @update:open="(o) => (createOpen = o)">
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ ENTRY_BUTTON_LABELS.snapshot }}</DialogTitle>
          <DialogDescription>
            保存后将成为手工记录并触发净值/XIRR 重算
          </DialogDescription>
        </DialogHeader>
        <SnapshotForm
          :portfolio-id="currentPortfolioId"
          @success="createOpen = false"
        />
      </DialogContent>
    </Dialog>

    <!-- 编辑弹窗（自动行保存后变手工） -->
    <Dialog
      :open="Boolean(editing)"
      @update:open="(o) => !o && (editing = null)"
    >
      <DialogContent class="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑资产记录</DialogTitle>
          <DialogDescription>
            保存后将变为手工记录（编辑 = 变手工）
          </DialogDescription>
        </DialogHeader>
        <!-- v-if 随 editing 卸载/重建，组件内 watch(snapshot) 重置表单 -->
        <SnapshotForm
          v-if="editing && currentPortfolioId"
          :portfolio-id="currentPortfolioId"
          :snapshot="editing"
          @success="editing = null"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>
