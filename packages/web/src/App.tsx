/**
 * App — 根组件
 *
 * - React Router v6 路由配置
 * - TanStack Query Provider
 * - Sonner Toaster
 * - 路由守卫 ProtectedRoute：未登录跳转 /login
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppLayout } from '@/components/layout/app-layout';
import LoginPage from '@/pages/login';
import RegisterPage from '@/pages/register';
import DashboardPage from '@/pages/dashboard';
import HoldingsPage from '@/pages/HoldingsPage';
import TransactionsPage from '@/pages/transactions';
import SnapshotsPage from '@/pages/snapshots';
import XirrAnalysisPage from '@/pages/xirr-analysis';
import NavAnalysisPage from '@/pages/nav-analysis';
import AccountPage from '@/pages/AccountPage';
import SettingsPage from '@/pages/settings';
import NotFoundPage from '@/pages/not-found';
import { useAuthStore } from '@/stores/auth.store';
import { ROUTE_PATH } from '@/lib/constants';
import type { JSX, ReactNode } from 'react';

/** TanStack Query 客户端（单例） */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** 路由守卫：未登录跳转 /login */
function ProtectedRoute({ children }: { children: ReactNode }): JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) {
    return <Navigate to={ROUTE_PATH.LOGIN} replace />;
  }
  return <>{children}</>;
}

/** 路由守卫：已登录时跳转 / */
function PublicOnlyRoute({ children }: { children: ReactNode }): JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (isAuthenticated) {
    return <Navigate to={ROUTE_PATH.DASHBOARD} replace />;
  }
  return <>{children}</>;
}

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* 公开路由 */}
          <Route
            path={ROUTE_PATH.LOGIN}
            element={
              <PublicOnlyRoute>
                <LoginPage />
              </PublicOnlyRoute>
            }
          />
          <Route
            path={ROUTE_PATH.REGISTER}
            element={
              <PublicOnlyRoute>
                <RegisterPage />
              </PublicOnlyRoute>
            }
          />

          {/* 受保护路由（共享 AppLayout） */}
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path={ROUTE_PATH.DASHBOARD} element={<DashboardPage />} />
            <Route path={ROUTE_PATH.HOLDINGS} element={<HoldingsPage />} />
            <Route path={ROUTE_PATH.TRANSACTIONS} element={<TransactionsPage />} />
            <Route path={ROUTE_PATH.SNAPSHOTS} element={<SnapshotsPage />} />
            <Route path={ROUTE_PATH.XIRR_ANALYSIS} element={<XirrAnalysisPage />} />
            <Route path={ROUTE_PATH.NAV_ANALYSIS} element={<NavAnalysisPage />} />
            <Route path={ROUTE_PATH.ACCOUNT} element={<AccountPage />} />
            <Route path={ROUTE_PATH.SETTINGS} element={<SettingsPage />} />
          </Route>

          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
