/**
 * modules/auth/composables/use-auth.ts — 认证相关 TanStack Vue Query hooks
 *
 * 自 React 版 web/src/hooks/use-auth.ts 平移：
 * - useLogin / useRegister：mutation，成功后写入 auth store + 路由跳转
 * - useProfile：query，获取当前用户信息并回写 auth store
 *
 * 差异说明：react-query → @tanstack/vue-query；useNavigate → useRouter；
 * zustand → pinia，行为逻辑逐行等价。
 */

import { watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { toast } from '@/composables/use-toast';
import { login as loginApi, register as registerApi, getProfile } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { AUTH_RETURN_KEY, AUTH_TOKEN_KEY, ROUTE_PATH } from '@/lib/constants';
import type { LoginRequest, RegisterRequest } from '@/api/types';

/**
 * 切换账号时彻底清空上个用户的本地状态，避免新账号残留旧数据：
 * - Vue Query 缓存（组合列表 / 偏好等）
 * - 组合 store（列表 + 当前选中）
 * - 偏好 store
 */
function resetSessionState(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.clear();
  usePortfolioStore().reset();
  usePreferenceStore().clear();
}

/** 登录 mutation */
export function useLogin() {
  const router = useRouter();
  const authStore = useAuthStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LoginRequest) => loginApi(payload),
    onSuccess: (data) => {
      resetSessionState(queryClient);
      authStore.login(data.accessToken, data.user);
      toast.success('登录成功');
      // 登录回跳：优先回到登录前意图路由，否则回默认首页。
      let target: string = ROUTE_PATH.DASHBOARD;
      try {
        const saved = sessionStorage.getItem(AUTH_RETURN_KEY);
        if (saved) {
          target = saved;
          sessionStorage.removeItem(AUTH_RETURN_KEY);
        }
      } catch {
        /* 忽略读取失败，回退默认首页 */
      }
      router.replace(target);
    },
  });
}

/** 注册 mutation */
export function useRegister() {
  const router = useRouter();
  return useMutation({
    mutationFn: (payload: RegisterRequest) => registerApi(payload),
    onSuccess: () => {
      toast.success('注册成功，请登录');
      router.push(ROUTE_PATH.LOGIN);
    },
  });
}

/** 获取当前用户信息 query */
export function useProfile() {
  const authStore = useAuthStore();
  const query = useQuery({
    queryKey: ['auth', 'profile'],
    queryFn: () => getProfile(),
    enabled: Boolean(typeof window !== 'undefined' && localStorage.getItem(AUTH_TOKEN_KEY)),
    staleTime: 5 * 60 * 1000,
  });

  // TanStack Query 无 useQuery 的 onSuccess 回调，改用 watch 在拿到
  // 最新用户数据时回写 auth store（含 role 等字段），保证 RBAC 依赖（useIsAdmin）
  // 在「角色变更 / 重新登录」后实时生效，而无需刷新页面。
  watch(query.data, (data) => {
    if (data) {
      authStore.setUser(data);
    }
  });

  return query;
}
