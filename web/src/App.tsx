/**
 * App 根组件
 *
 * 集成 React Router 路由 + QueryClientProvider + Toaster。
 * 路由结构（对齐 ARCH §10.1.1）：
 *   /login          → 登录页（公开）
 *   /register       → 注册页（公开）
 *   /               → Dashboard 概览（受保护）
 *   /holdings       → 持仓页（受保护）
 *   /cashflows      → 出入金管理页（受保护）
 *   /snapshots      → 历史总资产记录页（受保护）
 *   /analysis/xirr  → XIRR 分析页（受保护）
 *   /analysis/nav   → 净值分析页（受保护）
 *   /account        → 账户页（受保护；除「我的组合」块外只读，
 *                     「我的组合」= 全站唯一组合管理平面，承接组合 CRUD）
 *   /settings       → 设置页（受保护；账户资料/安全、偏好、数据管理与危险操作的修改入口）
 *   *               → 404
 */

import { type FC, lazy, Suspense } from 'react';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AppLayout } from '@/components/layout/app-layout';
import { AuthGuard } from '@/components/auth-guard';
import { PreferenceBootstrap } from '@/components/preference-bootstrap';
import { ThemeManager } from '@/components/theme-manager';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ROUTE_PATH } from '@/lib/constants';

// ── 懒加载页面 ──
const LoginPage = lazy(() => import('@/pages/login'));
const RegisterPage = lazy(() => import('@/pages/register'));
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const HoldingsPage = lazy(() => import('@/pages/HoldingsPage'));
const TransactionsPage = lazy(() => import('@/pages/transactions'));
const SnapshotsPage = lazy(() => import('@/pages/snapshots'));
const XirrAnalysisPage = lazy(() => import('@/pages/xirr-analysis'));
const NavAnalysisPage = lazy(() => import('@/pages/nav-analysis'));
const AccountPage = lazy(() => import('@/pages/AccountPage'));
const SettingsPage = lazy(() => import('@/pages/settings'));
const NotFoundPage = lazy(() => import('@/pages/not-found'));

/** 页面加载中 fallback */
function PageLoading(): JSX.Element {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <LoadingSpinner size="lg" />
    </div>
  );
}

// ── QueryClient ──
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30 * 1000,
    },
  },
});

// ── 路由配置 ──
const router = createBrowserRouter([
  // 公开路由
  {
    path: ROUTE_PATH.LOGIN,
    element: (
      <Suspense fallback={<PageLoading />}>
        <LoginPage />
      </Suspense>
    ),
  },
  {
    path: ROUTE_PATH.REGISTER,
    element: (
      <Suspense fallback={<PageLoading />}>
        <RegisterPage />
      </Suspense>
    ),
  },

  // 受保护路由（AuthGuard 包裹 AppLayout）
  {
    element: (
      <AuthGuard>
        <PreferenceBootstrap>
          <AppLayout />
        </PreferenceBootstrap>
      </AuthGuard>
    ),
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<PageLoading />}>
            <DashboardPage />
          </Suspense>
        ),
      },
      {
        path: 'holdings',
        element: (
          <Suspense fallback={<PageLoading />}>
            <HoldingsPage />
          </Suspense>
        ),
      },
      {
        path: 'cashflows',
        element: (
          <Suspense fallback={<PageLoading />}>
            <TransactionsPage />
          </Suspense>
        ),
      },
      {
        // FLOW-P0-01 验收4：/transactions → /cashflows 前端 301 语义
        // （React Router 内 replace 即 SPA 内重定向；真实 HTTP 301 由部署层配置，Part F-F9）
        path: 'transactions',
        element: <Navigate to={ROUTE_PATH.TRANSACTIONS} replace />,
      },
      {
        path: 'snapshots',
        element: (
          <Suspense fallback={<PageLoading />}>
            <SnapshotsPage />
          </Suspense>
        ),
      },
      {
        path: 'analysis/xirr',
        element: (
          <Suspense fallback={<PageLoading />}>
            <XirrAnalysisPage />
          </Suspense>
        ),
      },
      {
        path: 'analysis/nav',
        element: (
          <Suspense fallback={<PageLoading />}>
            <NavAnalysisPage />
          </Suspense>
        ),
      },
      {
        path: 'account',
        element: (
          <Suspense fallback={<PageLoading />}>
            <AccountPage />
          </Suspense>
        ),
      },
      {
        path: 'settings',
        element: (
          <Suspense fallback={<PageLoading />}>
            <SettingsPage />
          </Suspense>
        ),
      },
    ],
  },

  // 404
  {
    path: '*',
    element: (
      <Suspense fallback={<PageLoading />}>
        <NotFoundPage />
      </Suspense>
    ),
  },
]);

const App: FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeManager />
      <RouterProvider router={router} />
      <Toaster
        position="top-right"
        richColors
        closeButton
        toastOptions={{
          duration: 3000,
        }}
      />
    </QueryClientProvider>
  );
};

export default App;
