/**
 * hooks/use-system-config.ts — 系统配置（管理员）TanStack Query hooks
 *
 * - useSystemConfig：读取单项配置；非管理员（enabled:false）根本不发起请求，
 *   避免无权限用户被后端 403 打断。
 * - useUpdateSystemConfig：写入配置并失效对应缓存。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getSystemConfig,
  updateSystemConfig,
  type SystemConfig,
} from '@/api/admin.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 单项系统配置的 query key（与后端 key 绑定，供失效精确命中） */
export function systemConfigKey(key: string): unknown[] {
  return ['admin', 'system-config', key];
}

/** 读取单项系统配置（非管理员不发起请求） */
export function useSystemConfig(key: string) {
  const isAdmin = useIsAdmin();
  return useQuery<SystemConfig>({
    queryKey: systemConfigKey(key),
    queryFn: () => getSystemConfig(key),
    enabled: isAdmin,
  });
}

/** 更新单项系统配置 */
export function useUpdateSystemConfig(key: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: Record<string, unknown>) => updateSystemConfig(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: systemConfigKey(key) });
      toast.success('保存成功');
    },
    onError: () => {
      toast.error('保存失败，请重试');
    },
  });
}
