<script setup lang="ts">
/**
 * modules/settings/components/SettingsDataTab.vue — 「数据管理」页签内容
 *
 * 平移自 SettingsPage.vue 数据管理页签（纯位移，零行为变更）。
 * 纯展示组件：当前组合（门面 usePortfolios 派生）由 props 传入，
 * 本组件不新建任何数据 hook；导入对话框开关通过 emit 回传门面状态。
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import ExportPanel from '@/modules/data-transfer/components/ExportPanel.vue';
import ImportTemplateButtons from '@/modules/data-transfer/components/ImportTemplateButtons.vue';
import type { PortfolioResponse } from '@/api/types';

defineProps<{
  /** 当前组合（null 时导出区显示占位文案、导入按钮禁用） */
  currentPortfolio: PortfolioResponse | null;
}>();
const emit = defineEmits<{
  /** 打开导入对话框（门面 importOpen = true） */
  openImportDialog: [];
}>();
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">数据管理</CardTitle>
      <CardDescription>
        CSV / Excel 导出与导入（导入支持 .csv / .xlsx / .xls）
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <!-- 导出（SET-P0-03）：7 类多选 + 格式 + 串行下载 -->
      <div class="space-y-2">
        <Label class="text-sm">导出</Label>
        <ExportPanel
          v-if="currentPortfolio"
          :portfolio-id="currentPortfolio.id"
          :portfolio-name="currentPortfolio.name"
        />
        <p v-else class="text-xs text-muted-foreground">
          请先在顶部选择一个投资组合
        </p>
      </div>

      <!-- 导入（SET-P0-04 / FLOW-P1-01）：预览 → 提交 -->
      <div class="space-y-2">
        <Label class="text-sm">导入</Label>
        <div class="flex flex-wrap items-center gap-2">
          <ImportTemplateButtons />
          <Button
            variant="outline"
            size="sm"
            :disabled="!currentPortfolio"
            @click="emit('openImportDialog')"
          >
            选择文件并导入…
          </Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        Ⓘ 导入前建议先「导出」备份；证券买卖 / 出入金为追加写入，资产快照按日期覆盖。
      </p>
    </CardContent>
  </Card>
</template>
