/**
 * hooks/use-notification.ts — 站内信通知（管理员）TanStack Query hooks
 *
 * - useNotifications：列出全部通知（非管理员 enabled:false，避免 403）；
 *   返回数据连同派生字段 `unreadCount` 一并供铃铛徽标使用。
 * - useMarkNotificationRead：标记单条已读并失效列表缓存。
 *
 * 风格对齐 use-quote-provider.ts / use-quote-interface.ts：
 * useQuery enabled + useMutation 失效 + toast。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  listNotifications,
  markNotificationRead,
  type Notification,
} from '@/api/notification.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 通知列表的 query key（供失效精确命中） */
export function notificationsKey(): unknown[] {
  return ['admin', 'notifications'];
}

/** 读取全部通知（非管理员不发起请求） */
export function useNotifications() {
  const isAdmin = useIsAdmin();
  return useQuery<Notification[]>({
    queryKey: notificationsKey(),
    queryFn: listNotifications,
    enabled: isAdmin,
  });
}

/** 标记单条通知为已读 */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationsKey() });
    },
    onError: () => toast.error('标记已读失败，请重试'),
  });
}
