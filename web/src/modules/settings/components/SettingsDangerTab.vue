<script setup lang="ts">
/**
 * modules/settings/components/SettingsDangerTab.vue — 「危险操作区」页签内容
 *
 * 平移自 SettingsPage.vue 危险操作区页签（纯位移，零行为变更）。
 * 纯展示组件：当前组合（用于「清空数据」按钮的禁用与提示）由 props 传入，
 * 本组件不新建任何数据 hook；两个确认弹窗的打开通过 emit 回传门面
 （门面负责清空确认输入并置对应弹窗开关，确认/执行逻辑全部留在门面）。
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { PortfolioResponse } from '@/api/types';

defineProps<{
  /** 当前组合（null 时「清空数据」禁用并提示先选组合） */
  currentPortfolio: PortfolioResponse | null;
}>();
const emit = defineEmits<{
  /** 打开「清空当前组合数据」确认弹窗（门面清空确认输入并置 clearDataOpen = true） */
  openClearDialog: [];
  /** 打开「注销账户」确认弹窗（门面清空邮箱输入并置 deleteAccountOpen = true） */
  openDeleteDialog: [];
}>();
</script>

<template>
  <Card class="border-destructive/40">
    <CardHeader>
      <CardTitle class="text-base text-destructive">危险操作区</CardTitle>
      <CardDescription>以下操作不可恢复或代价极高，请谨慎执行</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <!-- 清空当前组合数据（SET-P0-05）：只清数据、保留组合 -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">清空当前组合数据</p>
          <p class="text-xs text-muted-foreground">
            删除当前组合的全部出入金、证券买卖、净值与 XIRR 等数据，
            但保留组合本身（SET-P0-05）
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          class="text-destructive hover:text-destructive"
          :disabled="!currentPortfolio"
          :title="currentPortfolio ? undefined : '请先在顶部选择一个组合'"
          @click="emit('openClearDialog')"
        >
          清空数据
        </Button>
      </div>

      <!-- 注销账户（SET-P1-06）：软删除账户本身及全部数据 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <div>
          <p class="text-sm font-semibold text-destructive">注销账户</p>
          <p class="text-xs text-muted-foreground">
            软删除账户本身及全部组合；30 天内可在登录页用原邮箱 + 密码自助恢复，
            超期由系统彻底删除（SET-P1-06）
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          @click="emit('openDeleteDialog')"
        >
          注销账户
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
