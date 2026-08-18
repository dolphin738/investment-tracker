<script setup lang="ts">
/**
 * modules/overview/components/PreferenceBootstrap.vue — 全局偏好引导加载
 *
 * 平移自 React 版 web/src/components/preference-bootstrap.tsx。
 *
 * 背景（SET-P0-02 验收 4）：
 * 概览页 / 分析页启动时需读取用户偏好作为默认值（默认时间维度、日期范围等）。
 * 这些页面此前只有在「设置页」保存/加载过偏好后，preference.store 才有数据；
 * 直接访问概览/分析页时 store 为空，只能拿到系统默认值，导致「偏好不生效」。
 *
 * 本组件挂在受保护路由的公共布局内（AppLayout）：
 * - 任意受保护页面首屏即发起一次 usePreferences() 查询
 * - 查询结果同步进 preference.store（Pinia）
 * - vue-query 缓存保证全站只请求一次；设置页保存后 invalidate 也会刷新这里
 *
 * 另负责「默认组合」生效：偏好加载完成后，若当前尚未选中任何组合，
 * 则自动选中偏好里的默认组合（未归档），否则回退到第一个「未归档」组合。
 * 仅在 currentPortfolioId 为空时执行，不会覆盖用户手动选择（修复 D3）。
 */

import { watch } from 'vue';
import { usePreferences } from '../composables/use-preferences';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolioStore } from '@/stores/portfolio.store';

const { data: serverPrefs } = usePreferences();
const preferenceStore = usePreferenceStore();
const portfolioStore = usePortfolioStore();

// 服务端偏好到达后同步进本地 store（偏好查询 watch 与 usePreferences 内部
// 各自同步一次不冲突——写入的是同一份最新值）。
watch(
  serverPrefs,
  (prefs) => {
    if (prefs) {
      preferenceStore.setPreferences(prefs);
    }
  },
);

// 「默认组合」生效：仅在未选中任何组合时兜底一次
watch(
  serverPrefs,
  (prefs) => {
    if (portfolioStore.currentPortfolioId !== null) {
      return;
    }
    const selectable = portfolioStore.portfolios.filter((p) => !p.archivedAt);
    if (selectable.length === 0) {
      return;
    }
    const defaultId = prefs?.defaultPortfolioId ?? null;
    const target =
      selectable.find((p) => p.id === defaultId)?.id ?? selectable[0].id;
    portfolioStore.setCurrentPortfolio(target);
  },
);
</script>

<template>
  <slot />
</template>
