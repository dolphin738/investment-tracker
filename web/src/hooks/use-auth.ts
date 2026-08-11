/**
 * hooks/use-auth.ts — 认证相关 TanStack Query hooks
 *
 * - useLogin / useRegister：mutation，成功后写入 auth store + 跳转
 * - useProfile：query，获取当前用户信息
 */

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { login as loginApi, register as registerApi, getProfile } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { ROUTE_PATH } from '@/lib/constants';
import type { LoginRequest, RegisterRequest } from '@/api/types';

/**
 * 切换账号时彻底清空上个用户的本地状态，避免新账号残留旧数据：
 * - React Query 缓存（组合列表 / 偏好等）
 * - 组合 store（列表 + 当前选中）
 * - 偏好 store
 */
function resetSessionState(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.clear();
  usePortfolioStore.getState().reset();
  usePreferenceStore.getState().clear();
}

/** 登录 mutation */
export function useLogin() {
  const navigate = useNavigate();
  const loginStore = useAuthStore((s) => s.login);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LoginRequest) => loginApi(payload),
    onSuccess: (data) => {
      resetSessionState(queryClient);
      loginStore(data.accessToken, data.user);
      toast.success('登录成功');
      navigate(ROUTE_PATH.DASHBOARD);
    },
  });
}

/** 注册 mutation */
export function useRegister() {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (payload: RegisterRequest) => registerApi(payload),
    onSuccess: () => {
      toast.success('注册成功，请登录');
      navigate(ROUTE_PATH.LOGIN);
    },
  });
}

/** 获取当前用户信息 query */
export function useProfile() {
  const query = useQuery({
    queryKey: ['auth', 'profile'],
    queryFn: () => getProfile(),
    enabled: Boolean(typeof window !== 'undefined' && localStorage.getItem('investment_tracker_token')),
    staleTime: 5 * 60 * 1000,
  });

  // TanStack Query v5 已移除 useQuery 的 onSuccess 回调，改用 useEffect 在拿到
  // 最新用户数据时回写 auth store（含 role 等字段），保证 RBAC 依赖（useIsAdmin）
  // 在「角色变更 / 重新登录」后实时生效，而无需刷新页面。
  useEffect(() => {
    if (query.data) {
      useAuthStore.getState().setUser(query.data);
    }
  }, [query.data]);

  return query;
}
