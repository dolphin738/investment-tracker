/**
 * stores/auth.store.ts — 认证状态（Pinia）
 *
 * 管理 JWT token + 当前用户信息，与 localStorage 持久化。
 * - login(): 存储 token + user（防御 undefined 写入）
 * - logout(): 清除 token + user
 * - isAuthenticated: 派生判断
 * - 初始化时从 localStorage 恢复，含 try-catch 防御脏数据
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { UserPublic } from '@/api/types';
import type { UserRole } from '@/lib/types';
import { AUTH_TOKEN_KEY, AUTH_USER_KEY } from '@/lib/constants';

/** 判断 token 是否为有效字符串（排除 null / undefined / "undefined"） */
function isValidToken(token: string | null): token is string {
  return Boolean(token) && token !== 'undefined' && token !== 'null';
}

/** 把可能缺失 avatar/phone/bio 的旧缓存 user 归一化（undefined → null） */
function normalizeUserPublic(user: UserPublic | null): UserPublic | null {
  if (!user) return null;
  return {
    ...user,
    avatar: user.avatar ?? null,
    phone: user.phone ?? null,
    bio: user.bio ?? null,
  };
}

/** 从 localStorage 恢复初始状态（含防御性解析） */
function loadInitialState(): { token: string | null; user: UserPublic | null } {
  if (typeof window === 'undefined') {
    return { token: null, user: null };
  }
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const userJson = localStorage.getItem(AUTH_USER_KEY);
  let user: UserPublic | null = null;

  if (userJson) {
    try {
      user = normalizeUserPublic(JSON.parse(userJson) as UserPublic);
    } catch {
      // 脏数据（如字符串 "undefined"），清除并重置
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  }

  const validToken = isValidToken(token) ? token : null;

  // 如果 token 无效但 localStorage 里有脏数据，清理掉
  if (!validToken && token) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }

  return { token: validToken, user };
}

export const useAuthStore = defineStore('auth', () => {
  const initial = loadInitialState();

  const token = ref<string | null>(initial.token);
  const user = ref<UserPublic | null>(initial.user);
  const isAuthenticated = computed(() => Boolean(token.value && user.value));

  function login(nextToken: string, nextUser: UserPublic): void {
    // 防御：token 或 user 为 undefined / null 时不写入 localStorage
    if (!nextToken || !nextUser) {
      return;
    }
    const normalized = normalizeUserPublic(nextUser);
    localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized));
    token.value = nextToken;
    user.value = normalized;
  }

  function logout(): void {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    token.value = null;
    user.value = null;
  }

  function setUser(nextUser: UserPublic): void {
    // 防御：user 为 undefined / null 时直接忽略。
    //
    // 早期没有这道判断时，任何「接口返回结构不符合预期」都会写入字符串 "null"，
    // 下次 loadInitialState() 解析出 user=null → isAuthenticated=false，
    // 表现为「操作时一切正常，一刷新就掉登录态」这种极难定位的故障
    // （头像上传的响应信封套娃 bug 就是这样把用户踢下线的）。
    // 保留旧用户信息远好过静默清空登录态。
    if (!nextUser) {
      return;
    }
    const normalized = normalizeUserPublic(nextUser);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized));
    user.value = normalized;
  }

  return { token, user, isAuthenticated, login, logout, setUser };
});

/**
 * 当前登录用户是否为管理员（role === 'admin'）。
 *
 * 供侧边栏「系统管理」入口过滤、AdminPage 权限门控等 RBAC 场景复用。
 * 防御性判断：user 缺失或 role 非 'admin' 时均判否。
 */
/** 当前登录用户是否拥有给定角色之一（多角色 RBAC 判断，方案 §4.4）。 */
export function useHasRole(...roles: UserRole[]): boolean {
  const role = useAuthStore().user?.role;
  return role !== undefined && roles.includes(role);
}

export function useIsAdmin(): boolean {
  return useHasRole('admin');
}
