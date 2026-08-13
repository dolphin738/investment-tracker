/**
 * api/notification.api.ts — 站内信通知（ADR-002 §3 Q2 默认「管理面站内信」）API
 *
 * 对应后端 modules/admin/router.py（前缀 /api/admin）：
 * - GET    /api/admin/notifications：站内信列表（按 created_at 倒序）
 * - POST   /api/admin/notifications/{notification_id}/read：标记单条为已读（不存在 → 404）
 *
 * 与 quote-provider.api.ts 保持一致的信封解包风格（http 已解包 data）。
 */

import { http } from '@/lib/api-client';

/** 通知等级（后端落库字符串，这里按值透传） */
export type NotificationLevel = 'info' | 'warning' | 'error';

/** 站内信通知（后端 NotificationOut 经信封解包后的结构） */
export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  /** 关联业务类型（如 quote_interface），可空 */
  related_type: string | null;
  /** 关联业务 id，可空 */
  related_id: string | null;
  /** 是否已读 */
  read: boolean;
  created_at: string;
}

/** 站内信列表 */
export function listNotifications(): Promise<Notification[]> {
  return http.get<Notification[]>('/admin/notifications');
}

/** 标记单条通知为已读，返回更新后的通知 */
export function markNotificationRead(
  notificationId: string,
): Promise<Notification> {
  return http.post<Notification>(
    `/admin/notifications/${encodeURIComponent(notificationId)}/read`,
  );
}
