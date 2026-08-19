/**
 * modules/account/composables/use-quote-sync.ts — 行情自动同步 vue-query hooks
 *
 * - useQuoteSync：读取当前用户行情同步配置（queryKey 含 token，按用户隔离缓存）。
 * - useSetQuoteSync：保存配置，成功后失效并 toast 反馈。
 * - useTriggerQuoteSync：手动立即同步一次，成功后失效并 toast 反馈。
 */

import { computed } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  getQuoteSync,
  setQuoteSync,
  triggerQuoteSync,
  type UserQuoteSyncConfigUpdate,
} from '@/api/quote-sync.api';
import { useAuthStore } from '@/stores/auth.store';

/** 行情同步配置 query key 前缀（失效命中含 token 的完整 key） */
export function quoteSyncKey(): unknown[] {
  return ['quote-sync'];
}

/** 读取当前用户行情同步配置；queryKey 追加 token，避免多账户间缓存串号 */
export function useQuoteSync() {
  const authStore = useAuthStore();
  return useQuery({
    queryKey: computed(() => [...quoteSyncKey(), authStore.token ?? '']),
    queryFn: getQuoteSync,
    enabled: Boolean(authStore.token),
  });
}

/** 保存配置（成功后后端重载调度） */
export function useSetQuoteSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UserQuoteSyncConfigUpdate) => setQuoteSync(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: quoteSyncKey() });
      toast.success('同步设置已保存');
    },
    onError: () => toast.error('同步设置保存失败，请检查配置'),
  });
}

/** 手动立即同步当前用户全部组合一次 */
export function useTriggerQuoteSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => triggerQuoteSync(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: quoteSyncKey() });
      toast.success('已触发同步，稍后刷新查看结果');
    },
    onError: () => toast.error('同步触发失败，请稍后重试'),
  });
}