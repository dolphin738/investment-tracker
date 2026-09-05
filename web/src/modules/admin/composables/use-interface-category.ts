/**
 * modules/admin/composables/use-interface-category.ts — 接口分类（管理员）vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-interface-category.ts，行为契约一致。
 * - useInterfaceCategories：列出全部分类（非管理员 enabled:isAdmin）；
 * - useCreateInterfaceCategory / useUpdateInterfaceCategory / useDeleteInterfaceCategory：
 *   新增 / 更新 / 删除分类，成功后失效分类列表缓存。
 *
 * 删除约束由后端强制（系统内置、分类下已配置接口时返回 400），
 * create / delete 失败文案透出后端 detail（err.message，对齐 useCreateQuoteProvider 写法）。
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

/** 新增分类（失败时透出后端 detail，如「已存在同名系统分类，不可重复创建」） */
export function useCreateInterfaceCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InterfaceCategoryCreate) => createInterfaceCategory(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: interfaceCategoriesKey() });
      toast.success('分类已新增');
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '新增失败，请检查参数';
      toast.error(message);
    },
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
    onError: () => toast.error('保存失败'),
  });
}

/** 删除分类（失败时透出后端 detail，如「系统内置分类不可删除」） */
export function useDeleteInterfaceCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInterfaceCategory(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: interfaceCategoriesKey() });
      toast.success('已删除');
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '删除失败';
      toast.error(message);
    },
  });
}
