<script setup lang="ts">
/**
 * modules/account/pages/AccountPage.vue — 账户中心（对齐 React 版 web/src/pages/AccountPage.tsx）
 *
 * 【只读契约】账户页整体是只读聚合视图，唯一例外是「我的组合」卡
 * （全站唯一的组合管理平面：新建 / 编辑 / 归档 / 删除 / 设为默认）。
 * 其余三张卡（个人信息 / 资产全景 / 数据统计）零修改控件：
 * 资料与安全修改在设置页，个人信息卡仅提供「前往设置修改 →」跳转。
 *
 * 四张卡（xl:grid-cols-12：3 / 5 / 4 / 12）：
 * - 个人信息（ACC-P0-02，只读）
 * - 资产全景（ACC-P0-03，只读）
 * - 数据统计（ACC-P0-06，只读）
 * - 我的组合（ACC-P0-04，唯一可写块）
 */
import PageHeader from '@/components/common/PageHeader.vue';
import AccountInfoCard from '../components/AccountInfoCard.vue';
import AssetOverviewCard from '../components/AssetOverviewCard.vue';
import StatsOverviewCard from '../components/StatsOverviewCard.vue';
import PortfolioManagementCard from '../components/PortfolioManagementCard.vue';
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="账户"
      description="账户中心 · 组合管理在「我的组合」卡完成；其余分区为只读聚合视图（资料与安全修改见设置页）"
    />
    <div class="grid grid-cols-1 gap-6 xl:grid-cols-12">
      <AccountInfoCard class="xl:col-span-3" />
      <AssetOverviewCard class="xl:col-span-5" />
      <StatsOverviewCard class="xl:col-span-4" />
      <!-- 我的组合：独占整行，不可挤 1/3 宽 -->
      <PortfolioManagementCard class="xl:col-span-12" />
    </div>
  </div>
</template>
