/**
 * modules/admin/composables/use-quote-provider.ts — 证券行情数据提供方（管理员）vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-quote-provider.ts，行为契约一致。
 * - useQuoteProviders：列出全部提供方；非管理员（enabled:false）不发起请求，
 *   避免无权限用户被后端 403 打断。
 * - useCreateQuoteProvider / useUpdateQuoteProvider / useDeleteQuoteProvider：
 *   各类写操作并在成功后失效列表缓存。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  createQuoteProvider,
  deleteQuoteProvider,
  listQuoteProviders,
  updateQuoteProvider,
  type QuoteProviderCreate,
  type QuoteProviderUpdate,
} from '@/api/quote-provider.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 提供方列表的 query key（供失效精确命中） */
export function quoteProvidersKey(): unknown[] {
  return ['admin', 'quote-providers'];
}

/** 读取全部提供方（非管理员不发起请求） */
export function useQuoteProviders() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: quoteProvidersKey(),
    queryFn: listQuoteProviders,
    enabled: isAdmin,
  });
}

/** 新增提供方 */
export function useCreateQuoteProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: QuoteProviderCreate) => createQuoteProvider(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: quoteProvidersKey() });
      toast.success('提供方已新增');
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '新增失败，请检查配置';
      toast.error(message);
    },
  });
}

/** 更新提供方（id 在 mutate 时动态传入，避免编辑时 id 为空导致 404） */
export function useUpdateQuoteProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: QuoteProviderUpdate }) =>
      updateQuoteProvider(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: quoteProvidersKey() });
      toast.success('已保存');
    },
    onError: () => toast.error('保存失败，请检查配置'),
  });
}

/** 删除提供方 */
export function useDeleteQuoteProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteQuoteProvider(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: quoteProvidersKey() });
      toast.success('已删除');
    },
    onError: () => toast.error('删除失败'),
  });
}