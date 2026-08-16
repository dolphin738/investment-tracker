/**
 * components/auth-guard.tsx — JWT 认证守卫
 *
 * 检查 auth store 中的 token 和 user：
 * - 已认证 → 渲染 children
 * - 未认证 → 重定向到 /login
 *
 * 在路由层包裹 AppLayout，实现全站 JWT 拦截。
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { AUTH_RETURN_KEY, ROUTE_PATH } from '@/lib/constants';
import type { ReactNode } from 'react';

export interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps): JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  // 未登录即将跳登录页前，记录受保护意图路由，供登录成功后回跳。
  // 跳过 /login 自身，避免覆盖此前已记录的深链意图。
  useEffect(() => {
    if (!isAuthenticated && location.pathname !== ROUTE_PATH.LOGIN) {
      try {
        sessionStorage.setItem(AUTH_RETURN_KEY, location.pathname + location.search);
      } catch {
        /* 隐私模式 / 配额：忽略存储失败 */
      }
    }
  }, [isAuthenticated, location.pathname, location.search]);

  if (!isAuthenticated) {
    return <Navigate to={ROUTE_PATH.LOGIN} replace />;
  }

  return <>{children}</>;
}
