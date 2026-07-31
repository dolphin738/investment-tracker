/**
 * hooks/use-auth.ts — 认证相关 TanStack Query hooks
 *
 * - useLogin / useRegister：mutation，成功后写入 auth store + 跳转
 * - useProfile：query，获取当前用户信息
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { login as loginApi, register as registerApi, getProfile } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { ROUTE_PATH } from '@/lib/constants';
import type { LoginRequest, RegisterRequest } from '@/api/types';

/** 登录 mutation */
export function useLogin() {
  const navigate = useNavigate();
  const loginStore = useAuthStore((s) => s.login);
  return useMutation({
    mutationFn: (payload: LoginRequest) => loginApi(payload),
    onSuccess: (data) => {
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
  return useQuery({
    queryKey: ['auth', 'profile'],
    queryFn: () => getProfile(),
    enabled: Boolean(typeof window !== 'undefined' && localStorage.getItem('investment_tracker_token')),
    staleTime: 5 * 60 * 1000,
  });
}
