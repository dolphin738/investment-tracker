/**
 * modules/admin/composables/use-interface-category.ts — 接口分类（管理员）vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-interface-category.ts，行为契约一致。
 * - useInterfaceCategories：列出全部分类（非管理员 enabled:isAdmin）；
 * - useCreateInterfaceCategory / useUpdateInterfaceCategory / useDeleteInterfaceCategory：
 *   各类写操作并失效分类列表缓存。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  createInterfaceCategory,
  deleteInterfaceCategory,
  listInterfaceCategories,
  updateInterfaceCategory,
  type InterfaceCategoryCreate,
  type InterfaceCategoryUpdate,
} from '@/api/interface-category.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 分类列表的 query key */
export function interfaceCategoriesKey(): unknown[] {
  return ['admin', 'interface-categories'];
}

/** 读取全部分类（非管理员不发起请求） */
export function useInterfaceCategories() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: interfaceCategoriesKey(),
    queryFn: listInterfaceCategories,
    enabled: isAdmin,
  });
}

/** 新增分类（key 重复时后端返回 409 / VALIDATION_FAILED，拦截器已 toast，此处不二次提示） */
export function useCreateInterfaceCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InterfaceCategoryCreate) => createInterfaceCategory(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: interfaceCategoriesKey() });
      toast.success('分类已新增');
    },
    onError: () => toast.error('新增失败（key 可能已存在）'),
  });
}

/** 更新分类 */
export function useUpdateInterfaceCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: InterfaceCategoryUpdate }) =>
      updateInterfaceCategory(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: interfaceCategoriesKey() });
      toast.success('已保存');
    },
    onError: () => toast.error('保存失败（key 可能已存在）'),
  });
}

/** 删除分类（不影响接口） */
export function useDeleteInterfaceCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInterfaceCategory(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: interfaceCategoriesKey() });
      toast.success('已删除');
    },
    onError: () => toast.error('删除失败'),
  });
}