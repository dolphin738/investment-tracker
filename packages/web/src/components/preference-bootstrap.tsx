/**
 * components/preference-bootstrap.tsx — 全局偏好引导加载
 *
 * 背景（SET-P0-02 验收 4）：
 * 概览页 / 分析页启动时需读取用户偏好作为默认值（默认时间维度、日期范围等）。
 * 这些页面此前只有在「设置页」保存/加载过偏好后，preference.store 才有数据；
 * 直接访问概览/分析页时 store 为空，只能拿到系统默认值，导致「偏好不生效」。
 *
 * 本组件挂在 AuthGuard 内（受保护路由统一包一层）：
 * - 任意受保护页面首屏即发起一次 usePreferences() 查询
 * - 查询结果同步进 preference.store（Zustand）
 * - TanStack Query 缓存保证全站只请求一次；设置页保存后 invalidate 也会刷新这里
 *
 * 注意：只订阅稳定的 setPreferences action（而非整个 store），
 * 避免「settings 页无限更新循环」同款问题（见 settings.test.tsx 回归测试）。
 */

import { useEffect, type ReactNode } from 'react';
import { usePreferences } from '@/hooks/use-preferences';
import { usePreferenceStore } from '@/stores/preference.store';

export interface PreferenceBootstrapProps {
  children: ReactNode;
}

export function PreferenceBootstrap({
  children,
}: PreferenceBootstrapProps): JSX.Element {
  const { data: serverPrefs } = usePreferences();
  const setPreferences = usePreferenceStore((s) => s.setPreferences);

  useEffect(() => {
    if (serverPrefs) {
      setPreferences(serverPrefs);
    }
  }, [serverPrefs, setPreferences]);

  return <>{children}</>;
}
