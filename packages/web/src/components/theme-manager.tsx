/**
 * components/theme-manager.tsx — 外观主题应用
 *
 * 读取偏好 store 中的 theme（light / dark / system），把对应 class 应用到
 * <html> 根节点，使 Tailwind 的 darkMode: ['class'] 真正生效（修复「外观主题」无效）。
 *
 * - light / dark：直接切换 <html class="dark">
 * - system：跟随操作系统 prefers-color-scheme，并监听其变化实时切换
 * - 把最终生效的主题持久化到 localStorage，配合 index.html 的内联脚本避免整页刷新瞬间闪烁
 *
 * 组件无渲染输出，仅执行副作用；挂在 App 根，全站常驻。
 */

import { useEffect } from 'react';
import { usePreferenceStore, DEFAULT_PREFERENCES } from '@/stores/preference.store';

/** 与 index.html 内联脚本保持一致的 localStorage key */
export const THEME_STORAGE_KEY = 'investment_tracker_theme';

type Theme = 'light' | 'dark' | 'system';

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

/** 应用主题到 <html> 根节点 */
function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const isDark = resolveDark(theme);
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

export function ThemeManager(): null {
  const storedTheme = usePreferenceStore(
    (s) => s.preferences?.theme ?? DEFAULT_PREFERENCES.theme,
  );
  const theme = storedTheme as Theme;

  useEffect(() => {
    applyTheme(theme);
    // 持久化，配合 index.html 内联脚本避免刷新闪烁
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* 忽略隐私模式等写入失败 */
    }

    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  return null;
}
