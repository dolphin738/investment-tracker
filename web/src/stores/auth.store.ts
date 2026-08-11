/**
 * stores/auth.store.ts — 认证状态（Zustand）
 *
 * 管理 JWT token + 当前用户信息，与 localStorage 持久化。
 * - login(): 存储 token + user（防御 undefined 写入）
 * - logout(): 清除 token + user
 * - isAuthenticated: 派生判断
 * - loadInitialState(): 从 localStorage 恢复，含 try-catch 防御脏数据
 */

import { create } from 'zustand';
import type { UserPublic } from '@/api/types';
import { AUTH_TOKEN_KEY, AUTH_USER_KEY } from '@/lib/constants';

interface AuthState {
  token: string | null;
  user: UserPublic | null;
  isAuthenticated: boolean;
  login: (token: string, user: UserPublic) => void;
  logout: () => void;
  setUser: (user: UserPublic) => void;
}

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
function loadInitialState(): Pick<AuthState, 'token' | 'user' | 'isAuthenticated'> {
  if (typeof window === 'undefined') {
    return { token: null, user: null, isAuthenticated: false };
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

  return {
    token: validToken,
    user,
    isAuthenticated: Boolean(validToken && user),
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadInitialState(),
  login: (token, user) => {
    // 防御：token 或 user 为 undefined / null 时不写入 localStorage
    if (!token || !user) {
      return;
    }
    const normalized = normalizeUserPublic(user);
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized));
    set({ token, user: normalized, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    set({ token: null, user: null, isAuthenticated: false });
  },
  setUser: (user) => {
    // 防御：user 为 undefined / null 时直接忽略。
    //
    // 早期没有这道判断时，任何「接口返回结构不符合预期」都会写入字符串 "null"，
    // 下次 loadInitialState() 解析出 user=null → isAuthenticated=false，
    // 表现为「操作时一切正常，一刷新就掉登录态」这种极难定位的故障
    // （头像上传的响应信封套娃 bug 就是这样把用户踢下线的）。
    // 保留旧用户信息远好过静默清空登录态。
    if (!user) {
      return;
    }
    const normalized = normalizeUserPublic(user);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized));
    set({ user: normalized });
  },
}));

/**
 * 当前登录用户是否为管理员（role === 'admin'）。
 *
 * 供侧边栏「系统管理」入口过滤、AdminPage 权限门控、useQuoteProviders 的
 * `enabled` 等 RBAC 场景复用。防御性判断：user 缺失或 role 非 'admin' 时均判否。
 */
export const useIsAdmin = (): boolean =>
  useAuthStore((s) => s.user?.role === 'admin');
