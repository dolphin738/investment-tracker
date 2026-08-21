/**
 * router/index.ts — Vue Router 路由配置与守卫
 *
 * 路由结构（对齐 ARCH §10.1.1 与 React 版 App.tsx）：
 *   /login          → 登录页（公开）
 *   /register       → 注册页（公开）
 *   /               → Dashboard 概览（受保护）
 *   /holdings       → 持仓页（受保护）
 *   /cashflows      → 出入金管理页（受保护）
 *   /snapshots      → 历史总资产记录页（受保护）
 *   /analysis/xirr  → XIRR 分析页（受保护）
 *   /analysis/nav   → 净值分析页（受保护）
 *   /account        → 账户页（受保护）
 *   /settings       → 设置页（受保护）
 *   /admin          → 系统管理页（受保护）
 *   /transactions   → /cashflows 重定向（FLOW-P0-01 前端 301 语义）
 *   /:pathMatch(.*) → 404
 *
 * 认证守卫对齐 React 版 AuthGuard：未认证跳 /login 前，把受保护意图路由
 * 记入 sessionStorage，供登录成功后回跳。
 */

import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth.store';
import { AUTH_RETURN_KEY, ROUTE_PATH } from '@/lib/constants';

const routes: RouteRecordRaw[] = [
  // 公开路由
  {
    path: ROUTE_PATH.LOGIN,
    name: 'login',
    component: () => import('@/modules/auth/pages/LoginPage.vue'),
  },
  {
    path: ROUTE_PATH.REGISTER,
    name: 'register',
    component: () => import('@/modules/auth/pages/RegisterPage.vue'),
  },

  // 受保护路由（守卫 + 主布局）
  {
    path: '/',
    component: () => import('@/components/layout/AppLayout.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/modules/overview/pages/DashboardPage.vue'),
      },
      {
        path: 'holdings',
        name: 'holdings',
        component: () => import('@/modules/holdings/pages/HoldingsPage.vue'),
      },
      {
        path: 'cashflows',
        name: 'cashflows',
        component: () => import('@/modules/cashflow/pages/TransactionsPage.vue'),
      },
      {
        // FLOW-P0-01 验收4：/transactions → /cashflows 前端 301 语义
        path: 'transactions',
        redirect: { path: ROUTE_PATH.TRANSACTIONS },
      },
      {
        path: 'snapshots',
        name: 'snapshots',
        component: () => import('@/modules/snapshot/pages/SnapshotsPage.vue'),
      },
      {
        path: 'analysis/xirr',
        name: 'xirr-analysis',
        component: () => import('@/modules/analysis/pages/XirrAnalysisPage.vue'),
      },
      {
        path: 'analysis/nav',
        name: 'nav-analysis',
        component: () => import('@/modules/analysis/pages/NavAnalysisPage.vue'),
      },
      {
        path: 'account',
        name: 'account',
        component: () => import('@/modules/account/pages/AccountPage.vue'),
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/modules/settings/pages/SettingsPage.vue'),
      },
      {
        path: 'admin',
        name: 'admin',
        component: () => import('@/modules/admin/pages/AdminPage.vue'),
      },
      {
        path: 'admin/tasks',
        name: 'admin-tasks',
        component: () => import('@/modules/admin/pages/SchedulePage.vue'),
      },
      {
        path: 'admin/logs',
        name: 'admin-logs',
        component: () => import('@/modules/admin/pages/LogCenterPage.vue'),
      },
    ],
  },

  // 404
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/pages/not-found.vue'),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/** 全局前置守卫：JWT 认证拦截 + 回跳意图记录 */
router.beforeEach((to) => {
  const auth = useAuthStore();

  // 公开页面直接放行
  if (to.path === ROUTE_PATH.LOGIN || to.path === ROUTE_PATH.REGISTER) {
    return true;
  }

  if (!auth.isAuthenticated) {
    // 未登录即将跳登录页前，记录受保护意图路由，供登录成功后回跳。
    // 跳过 /login 自身，避免覆盖此前已记录的深链意图。
    if (to.path !== ROUTE_PATH.LOGIN) {
      try {
        // to.fullPath = path + query + hash，与 React 版 pathname + search 语义一致
        sessionStorage.setItem(AUTH_RETURN_KEY, to.fullPath);
      } catch {
        /* 隐私模式 / 配额：忽略存储失败 */
      }
    }
    return { path: ROUTE_PATH.LOGIN, replace: true };
  }

  return true;
});

export default router;
