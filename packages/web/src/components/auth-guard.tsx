/**
 * components/auth-guard.tsx — JWT 认证守卫
 *
 * 检查 auth store 中的 token 和 user：
 * - 已认证 → 渲染 children
 * - 未认证 → 重定向到 /login
 *
 * 在路由层包裹 AppLayout，实现全站 JWT 拦截。
 */

import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { ROUTE_PATH } from '@/lib/constants';
import type { ReactNode } from 'react';

export interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps): JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to={ROUTE_PATH.LOGIN} replace />;
  }

  return <>{children}</>;
}
