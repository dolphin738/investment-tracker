/**
 * router/__tests__/guard.test.ts — 全局前置守卫（FE-GLOBAL-01）
 *
 * 覆盖（REP-007 · 前端 P0 部分覆盖补全）：
 * 1. 未登录访问受保护路由 → 返回重定向 { path: /login, replace: true } 且把深链
 *    意图记入 sessionStorage[AUTH_RETURN_KEY]，供登录成功后回跳。
 * 2. 已登录访问受保护路由 → 返回 true（放行），且不写入回跳意图。
 * 3. 公开路由 /login、/register → 返回 true（始终放行，不记深链）。
 *
 * 直接调用 router.beforeGuards 中已注册的守卫函数（真实守卫逻辑，零导航开销，
 * 规避 createWebHistory 在 jsdom 下的异步挂起）。守卫内部依赖 useAuthStore，
 * 故每个用例前需 setActivePinia。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { RouteLocationNormalized } from 'vue-router';

import { authGuard } from '@/router';
import { useAuthStore } from '@/stores/auth.store';
import { AUTH_RETURN_KEY, ROUTE_PATH } from '@/lib/constants';
import type { UserPublic } from '@/api/types';

const USER: UserPublic = {
  id: 'u1',
  email: 'guard@example.com',
  name: 'Guard',
  role: 'user',
  avatar: null,
  phone: null,
  bio: null,
} as UserPublic;

function fakeTo(path: string): RouteLocationNormalized {
  return {
    path,
    fullPath: path,
    name: undefined,
    params: {},
    query: {},
    hash: '',
    matched: [],
    meta: {},
    redirectedFrom: undefined,
  } as unknown as RouteLocationNormalized;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});

describe('router 全局前置守卫（FE-GLOBAL-01）', () => {
  it('未登录访问受保护路由 → 重定向 /login（replace）并记录深链意图', () => {
    const authStore = useAuthStore();
    expect(authStore.isAuthenticated).toBe(false);

    const res = authGuard(fakeTo(ROUTE_PATH.HOLDINGS));

    expect(res).toEqual({ path: ROUTE_PATH.LOGIN, replace: true });
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBe(ROUTE_PATH.HOLDINGS);
  });

  it('已登录访问受保护路由 → 放行且不写回跳意图', () => {
    const authStore = useAuthStore();
    authStore.login('fake-token', USER);
    expect(authStore.isAuthenticated).toBe(true);

    const res = authGuard(fakeTo(ROUTE_PATH.HOLDINGS));

    expect(res).toBe(true);
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('公开路由 /login、/register 始终放行', () => {
    const authStore = useAuthStore();
    expect(authStore.isAuthenticated).toBe(false);

    expect(authGuard(fakeTo(ROUTE_PATH.LOGIN))).toBe(true);
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();

    expect(authGuard(fakeTo(ROUTE_PATH.REGISTER))).toBe(true);
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });
});
