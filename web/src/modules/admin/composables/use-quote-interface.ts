/**
 * modules/admin/composables/use-quote-interface.ts — 提供方接口（管理员）vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-quote-interface.ts，行为契约一致。
 * - useQuoteInterfaces：列出某提供方接口（非管理员 enabled:isAdmin）；
 * - useQuoteInterfacesAll：扁平返回全部接口（顶层按分类汇总总览）；
 * - useCreateInterface / useUpdateInterface / useDeleteInterface：各类写操作并失效列表缓存。
 * - useReorderInterfaces：同分类内拖拽调序（ADR-002 优先级链）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  createInterface,
  deleteInterface,
  fetchResponseFieldSchema,
  listAllInterfaces,
  listProviderInterfaces,
  reorderQuoteInterfaces,
  updateInterface,
  type QuoteInterfaceCreate,
  type QuoteInterfaceUpdate,
  type ReorderQuoteInterfacesReq,
} from '@/api/quote-interface.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 某提供方接口列表的 query key */
export function quoteInterfacesKey(providerId: string): unknown[] {
  return ['admin', 'quote-providers', providerId, 'interfaces'];
}

/** 全部接口（顶层按分类汇总）的 query key */
export function quoteInterfacesAllKey(): unknown[] {
  return ['admin', 'quote-providers', 'interfaces', 'all'];
}

/** 读取某提供方全部接口（非管理员不发起请求） */
export function useQuoteInterfaces(providerId: string) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: quoteInterfacesKey(providerId),
    queryFn: () => listProviderInterfaces(providerId),
    enabled: isAdmin && Boolean(providerId),
  });
}

/** 读取全部接口（扁平，供顶层按分类汇总总览；非管理员不发起请求） */
export function useQuoteInterfacesAll() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: quoteInterfacesAllKey(),
    queryFn: listAllInterfaces,
    enabled: isAdmin,
  });
}

/** 新增接口（providerId 决定归属 + 失效对应缓存） */
export function useCreateInterface(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: QuoteInterfaceCreate) => createInterface(providerId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: quoteInterfacesKey(providerId) });
      queryClient.invalidateQueries({ queryKey: quoteInterfacesAllKey() });
      toast.success('接口已新增');
    },
    onError: () => toast.error('新增失败，请检查参数'),
  });
}

/** 更新接口（失效全部接口相关缓存，兼容总览与各提供方子表） */
export function useUpdateInterface() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: QuoteInterfaceUpdate }) =>
      updateInterface(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'quote-providers'] });
      toast.success('已保存');
    },
    onError: () => toast.error('保存失败，请检查参数'),
  });
}

/** 删除接口（失效全部接口相关缓存） */
export function useDeleteInterface() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInterface(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'quote-providers'] });
      toast.success('已删除');
    },
    onError: () => toast.error('删除失败'),
  });
}

/**
 * 同分类内拖拽调序（ADR-002 优先级链）。
 *
 * 入参为拖拽产生的完整有序 id 列表；成功后失效全部接口相关缓存
 * （兼容顶层「按分类汇总总览」与各提供方子表），并轻提示。
 */
export function useReorderInterfaces() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ReorderQuoteInterfacesReq) => reorderQuoteInterfaces(body),
    onSuccess: () => {
      // 前缀命中：总览 / 各提供方子表 / 单提供方接口列表全部刷新
      queryClient.invalidateQueries({ queryKey: ['admin', 'quote-providers'] });
      toast.success('顺序已保存');
    },
    onError: () => toast.error('调序失败，请重试'),
  });
}

/**
 * 响应字段契约 schema（GET /admin/quote-interfaces/response-field-schema，需管理员）。
 *
 * 「字段映射」表格的 slot 下拉 / 类型 / 单位 / 按分类必填提示的唯一数据源
 * （方案 §6 单源供给）；非管理员不发起请求（后端 403）。
 */
export function useResponseFieldSchema() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ['admin', 'quote-interfaces', 'response-field-schema'],
    queryFn: fetchResponseFieldSchema,
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });
}