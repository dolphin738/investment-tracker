/**
 * modules/auth/composables/use-account.ts — 账户自助恢复 mutation hook
 *
 * 自 React 版 web/src/hooks/use-account.ts 平移本模块所需的部分（登录页
 * AccountRestorePrompt 场景）。其余改密码 / 改邮箱 / 改资料等 hooks 属于
 * 账户设置页批次（B1+），不在本批次迁移范围。
 *
 * 注销账户自助恢复（SYS-P1-02）：对应后端 POST /api/auth/account/restore（免 JWT）。
 * 凭邮箱 + 密码清空软删标记，成功后直接把返回的 accessToken + 用户信息写入
 * auth store，无需再登录一次，随后跳转到概览页。
 *
 * 不写 onError：1008 未注销 / 1009 已过冷静期 / 1001 密码错等失败
 * 由 api-client 拦截器统一 toast 处理。
 */

import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { toast } from '@/composables/use-toast';
import { restoreAccount as restoreAccountApi } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { ROUTE_PATH } from '@/lib/constants';
import type { RestoreRequest } from '@/api/types';

/** 注销账户自助恢复（登录页恢复引导卡片使用） */
export function useRestoreAccount() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const authStore = useAuthStore();
  return useMutation({
    mutationFn: (payload: RestoreRequest) => restoreAccountApi(payload),
    onSuccess: (data) => {
      authStore.login(data.accessToken, data.user);
      toast.success('账户已恢复');
      queryClient.clear();
      router.push(ROUTE_PATH.DASHBOARD);
    },
  });
}
