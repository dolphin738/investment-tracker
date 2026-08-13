/**
 * features/admin/notification-bell.tsx — 顶栏通知铃铛（ADR-002 §3 Q2 默认「管理面站内信」）
 *
 * - 铃铛图标 + 未读红色徽标（角标显示未读数，>99 显示 99+）。
 * - 点击展开下拉：列出全部通知（标题 / 正文 / 时间 / 已读灰显）；
 *   未读项提供「标记已读」按钮，点击调用 markNotificationRead 并失效列表。
 * - 仅管理员可见：由 app-layout.tsx 通过 useIsAdmin() 控制挂载（铃铛自身查询也用
 *   enabled:useIsAdmin 双重防御，避免非管理员 403）。
 *
 * 复用 components/ui/dropdown-menu 与 hooks/use-notification。
 */

import { useState } from 'react';
import { Bell } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useMarkNotificationRead, useNotifications } from '@/hooks/use-notification';
import type { Notification } from '@/api/notification.api';

/** 北京时间（UTC+8）下格式化通知时间：MM-dd HH:mm */
function formatNotificationTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  // 与 lib/constants.nowInAppTzIso 同一不变式：+8h 后取 UTC 渲染，结果只由物理时刻决定
  const app = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const s = app.toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`; // MM-dd HH:mm
}

export function NotificationBell(): JSX.Element {
  const { data: notifications, isLoading } = useNotifications();
  const markRead = useMarkNotificationRead();
  const [open, setOpen] = useState(false);

  const items = notifications ?? [];
  const unreadCount = items.filter((n: Notification) => !n.read).length;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unreadCount > 0 ? `通知（${unreadCount} 条未读）` : '通知'}
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] leading-none"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>通知</span>
          {unreadCount > 0 && (
            <Badge variant="secondary" className="text-xs">
              {unreadCount} 条未读
            </Badge>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isLoading && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        )}
        {!isLoading && items.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            暂无通知
          </p>
        )}
        {!isLoading &&
          items.map((n: Notification) => (
            <div
              key={n.id}
              className={cn(
                'flex flex-col gap-1 border-b px-3 py-2 last:border-0',
                n.read ? 'opacity-60' : 'bg-muted/40',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium leading-snug">
                    {n.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatNotificationTime(n.created_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{n.message}</p>
                {!n.read && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-7 self-end px-2 text-xs"
                    onClick={(e) => {
                      // 阻止冒泡到 DropdownMenuItem（避免关闭菜单），仅触发标记已读
                      e.stopPropagation();
                      markRead.mutate(n.id);
                    }}
                  >
                    标记已读
                  </Button>
                )}
              </div>
            </div>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
