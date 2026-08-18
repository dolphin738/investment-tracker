/**
 * modules/admin/composables/use-notifications.ts — 站内信通知 vue-query hooks
 *
 * 对应后端 /api/admin/notifications（管理面行情同步告警落点，ADR-002 §3 Q2）：
 * - useNotifications：站内信列表（GET /admin/notifications，仅 admin 调用）
 * - useMarkNotificationRead：标记单条已读（POST /admin/notifications/{id}/read），
 *   成功后本地乐观更新缓存（setQueryData），避免整列表闪动。
 *
 * 说明：通知是全局管理面告警（非 per-user），后端 require_admin 守卫；
 * 前端仅 admin 可见（AppLayout 按 isAdmin 控制挂载）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  listNotifications,
  markNotificationRead,
  type Notification,
} from '@/api/notification.api';

/** 查询 key（与 useNotifications / useMarkNotificationRead 共享） */
export const NOTIFICATIONS_KEY = ['admin', 'notifications'] as const;

/** 站内信列表（挂载即拉取；行情同步是低频事件，打开铃/手动刷新足够，不轮询） */
export function useNotifications() {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY],
    queryFn: () => listNotifications(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 标记单条已读：成功后 setQueryData 就地更新，保持列表顺序不闪动 */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: (updated) => {
      queryClient.setQueryData<Notification[]>(
        [...NOTIFICATIONS_KEY],
        (old) => old?.map((n) => (n.id === updated.id ? updated : n)),
      );
    },
  });
}
