<script setup lang="ts">
/**
 * modules/admin/components/NotificationBell.vue — 顶栏站内信通知铃（管理面）
 *
 * 消费后端 GET/POST /api/admin/notifications（ADR-002 §3 Q2 行情同步告警）。
 * 仅 admin 可见（父级 AppLayout 按 useIsAdmin 控制挂载，后端另有 require_admin 兜底）。
 *
 * - 铃图标 + 未读数红色徽标（read=false 数量，无未读不显示）
 * - 下拉列表：level 着色徽标 / title / message / 时间；点击未读条目标记已读（就地更新）
 * - 空态 / 加载态 / 手动刷新
 */
import { Bell, RefreshCw, Loader2 } from 'lucide-vue-next';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Notification, NotificationLevel } from '@/api/notification.api';
import {
  useMarkNotificationRead,
  useNotifications,
} from '../composables/use-notifications';

const { data: items, isLoading, isError, refetch } = useNotifications();
const markRead = useMarkNotificationRead();

const unreadCount = computed(
  () => items.value?.filter((n) => !n.read).length ?? 0,
);

/** 等级徽标配色（error 红 / warning 琥珀 / info 灰） */
const LEVEL_CLASS: Record<NotificationLevel, string> = {
  error: 'border-transparent bg-destructive text-destructive-foreground',
  warning: 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400',
  info: 'border-transparent bg-muted text-muted-foreground',
};

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  error: '错误',
  warning: '告警',
  info: '信息',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function handleClick(n: Notification): void {
  if (!n.read) {
    markRead.mutate(n.id);
  }
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      class="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="站内信通知"
    >
      <Bell class="h-4 w-4" />
      <span
        v-if="unreadCount > 0"
        class="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"
        :title="`${unreadCount} 条未读`"
      >
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-[340px]">
      <DropdownMenuLabel class="flex items-center justify-between">
        <span>站内信通知</span>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
          :disabled="isLoading"
          @click="refetch"
        >
          <RefreshCw :class="cn('h-3 w-3', isLoading && 'animate-spin')" />
          刷新
        </Button>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />

      <div class="max-h-[320px] overflow-y-auto">
        <!-- 加载态 -->
        <div v-if="isLoading" class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          加载中…
        </div>

        <!-- 失败态 -->
        <div v-else-if="isError" class="py-8 text-center text-sm text-destructive">
          通知加载失败
        </div>

        <!-- 空态 -->
        <div v-else-if="(items?.length ?? 0) === 0" class="py-8 text-center text-sm text-muted-foreground">
          暂无通知
        </div>

        <!-- 列表 -->
        <button
          v-for="n in items ?? []"
          :key="n.id"
          type="button"
          class="flex w-full items-start gap-2.5 border-b border-border/60 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent/60"
          :title="n.read ? undefined : '点击标记已读'"
          @click="handleClick(n)"
        >
          <Badge :class="LEVEL_CLASS[n.level] ?? LEVEL_CLASS.info" class="mt-0.5 shrink-0">
            {{ LEVEL_LABEL[n.level] ?? n.level }}
          </Badge>
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-sm font-medium">{{ n.title }}</span>
            <span v-if="n.message" class="line-clamp-2 text-xs text-muted-foreground">
              {{ n.message }}
            </span>
            <span class="text-[11px] text-muted-foreground/80">{{ formatTime(n.created_at) }}</span>
          </span>
          <span
            v-if="!n.read"
            class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
            aria-label="未读"
          />
        </button>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
