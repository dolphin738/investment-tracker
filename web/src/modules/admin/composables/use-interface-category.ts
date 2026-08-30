/**
 * modules/admin/composables/use-interface-category.ts — 接口分类（管理员）vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-interface-category.ts，行为契约一致。
 * - useInterfaceCategories：列出全部分类（非管理员 enabled:isAdmin）；
 * - useUpdateInterfaceCategory：更新分类并失效分类列表缓存。
 *
 * 分类改版后为固定分类，前端不提供新增/删除入口（后端端点保留），
 * 故不再封装 create / delete 两个写操作 hook。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  listInterfaceCategories,
  updateInterfaceCategory,
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