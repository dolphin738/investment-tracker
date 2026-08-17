<script lang="ts">
/**
 * components/common/ThemeManager.vue — 外观主题应用
 *
 * 读取偏好 store 中的 theme（light / dark / system），把对应 class 应用到
 * html 根节点，使 Tailwind 的 darkMode: ['class'] 真正生效（修复「外观主题」无效）。
 *
 * - light / dark：直接切换 html class="dark"
 * - system：跟随操作系统 prefers-color-scheme，并监听其变化实时切换
 * - 把最终生效的主题持久化到 localStorage，配合 index.html 的内联脚本避免整页刷新瞬间闪烁
 *
 * 组件无渲染输出，仅执行副作用；挂在 App 根，全站常驻。
 */

/** 与 index.html 内联脚本保持一致的 localStorage key（script setup 不允许命名导出，故置于普通 script 块） */
export const THEME_STORAGE_KEY = 'investment_tracker_theme';

export type Theme = 'light' | 'dark' | 'system';
</script>

<script setup lang="ts">
import { computed, onScopeDispose, watchEffect } from 'vue';
import { usePreferenceStore } from '@/stores/preference.store';

/** 根据偏好主题计算当前是否应为暗色 */
function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  // system：跟随操作系统
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** 应用主题到 html 根节点 */
function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const isDark = resolveDark(theme);
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

const preferenceStore = usePreferenceStore();
const theme = computed<Theme>(() => preferenceStore.theme as Theme);

// 系统主题变化监听器（theme 为 system 时实时跟随）
let disposeMediaListener: (() => void) | null = null;

watchEffect(() => {
  applyTheme(theme.value);
  // 持久化，配合 index.html 内联脚本避免刷新闪烁
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme.value);
  } catch {
    /* 忽略隐私模式等写入失败 */
  }

  // 先卸载旧监听，再按需为 system 主题挂载新监听
  disposeMediaListener?.();
  disposeMediaListener = null;
  if (theme.value === 'system') {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme('system');
    media.addEventListener('change', onChange);
    disposeMediaListener = () => media.removeEventListener('change', onChange);
  }
});

onScopeDispose(() => {
  disposeMediaListener?.();
});
</script>

<template>
  <!-- 无渲染输出，仅执行主题副作用 -->
</template>
