/**
 * hooks/use-account.ts — 账户设置（改密码 / 改邮箱 / 改资料 / 传头像）mutation hooks
 *
 * 说明：
 * - 改密码 / 改邮箱后端会重签 token，这里用 authStore.login() 覆盖旧 token，
 *   避免旧 token 的 payload.email 与实际邮箱不一致。
 * - 改资料 / 传头像只更新用户信息，用 authStore.setUser()。
 * - 不写 onError：api-client 拦截器已全局 toast 错误，重复处理会双弹。
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  deleteAccount as deleteAccountApi,
  updateEmail as updateEmailApi,
  updatePassword as updatePasswordApi,
  updateProfile as updateProfileApi,
} from '@/api/auth.api';
import { uploadAvatar as uploadAvatarApi } from '@/api/upload.api';
import { useAuthStore } from '@/stores/auth.store';
import { ROUTE_PATH } from '@/lib/constants';
import type {
  UpdateEmailRequest,
  UpdatePasswordRequest,
  UpdateProfileRequest,
} from '@/api/types';

/** 当前用户信息 query key（与 use-auth.ts 的 useProfile 保持一致） */
export const AUTH_PROFILE_KEY = ['auth', 'profile'] as const;

/** 修改密码 */
export function useUpdatePassword() {
  const queryClient = useQueryClient();
  const loginStore = useAuthStore((s) => s.login);
  return useMutation({
    mutationFn: (payload: UpdatePasswordRequest) => updatePasswordApi(payload),
    onSuccess: (data) => {
      loginStore(data.accessToken, data.user);
      toast.success('密码修改成功');
      queryClient.invalidateQueries({ queryKey: AUTH_PROFILE_KEY });
    },
  });
}

/** 修改邮箱 */
export function useUpdateEmail() {
  const queryClient = useQueryClient();
  const loginStore = useAuthStore((s) => s.login);
  return useMutation({
    mutationFn: (payload: UpdateEmailRequest) => updateEmailApi(payload),
    onSuccess: (data) => {
      loginStore(data.accessToken, data.user);
      toast.success('邮箱已更新，下次请使用新邮箱登录');
      queryClient.invalidateQueries({ queryKey: AUTH_PROFILE_KEY });
    },
  });
}

/** 修改个人资料 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (payload: UpdateProfileRequest) => updateProfileApi(payload),
    onSuccess: (data) => {
      setUser(data);
      toast.success('资料已更新');
      queryClient.invalidateQueries({ queryKey: AUTH_PROFILE_KEY });
    },
  });
}

/**
 * 上传头像
 *
 * 后端在同一个请求里完成「落盘 + 写库」，返回的 user 已经是最新状态，
 * 所以这里直接 setUser()，导航栏头像（AC-15）会立即跟着刷新。
 */
export function useUploadAvatar() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (file: File) => uploadAvatarApi(file),
    onSuccess: (data) => {
      setUser(data.user);
      toast.success('头像上传成功');
      queryClient.invalidateQueries({ queryKey: AUTH_PROFILE_KEY });
    },
  });
}

/**
 * 注销账户（SET-P1-06 · 设置页危险操作区）
 *
 * 成功后清除本地登录态并回到登录页。
 */
export function useDeleteAccount() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  return useMutation({
    mutationFn: () => deleteAccountApi(),
    onSuccess: () => {
      toast.success('账户已注销');
      logout();
      queryClient.clear();
      navigate(ROUTE_PATH.LOGIN);
    },
  });
}
