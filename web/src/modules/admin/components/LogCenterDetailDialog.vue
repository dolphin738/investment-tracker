<script setup lang="ts">
/**
 * modules/admin/components/LogCenterDetailDialog.vue — 日志详情弹窗
 *
 * 从 LogCenterPage 抽出：展示单条日志详情（来源/级别/作用域/模块/用户/消息/堆栈/附加信息）。
 * 详情数据由门面经 useLogDetail(detailId) 取回后下传（detail / detailLoading），弹窗受控
 * 于门面 detailId；关闭（open 变 false）经 close 事件上抛，由门面清空 detailId。展示辅助
 * 函数（levelVariant 等）与 stringifyDetail 随本组件一并抽出，保持模板逐字节等价。
 * 纯位置性拆分，零行为变更。
 */
import { formatDateTime } from '@/lib/utils';
import { Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariants } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LogItem } from '@/api/log-center.api';

const props = defineProps<{
  /** 弹窗是否打开（由门面 detailId !== null 驱动） */
  open: boolean;
  /** 详情数据（门面 useLogDetail 解析结果） */
  detail: LogItem | null | undefined;
  /** 详情加载中 */
  detailLoading: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

// ---------------------------------------------------------------------------
// 展示辅助（与门面拆分前一致，随本组件一并抽出）
// ---------------------------------------------------------------------------
type BadgeVariant = NonNullable<BadgeVariants['variant']>;

function levelVariant(level: string | null): BadgeVariant {
  if (level === 'error') return 'destructive';
  if (level === 'warning') return 'secondary';
  return 'outline';
}
function levelLabel(level: string | null): string {
  if (level === 'error') return '错误';
  if (level === 'warning') return '警告';
  if (level === 'info') return '信息';
  return level ?? '-';
}
function sourceVariant(source: string | null): BadgeVariant {
  if (source === 'app') return 'default';
  if (source === 'notification') return 'secondary';
  return 'outline';
}
function sourceLabel(source: string | null): string {
  if (source === 'app') return '应用';
  if (source === 'notification') return '通知';
  if (source === 'job') return '任务';
  return source ?? '-';
}
function scopeVariant(scope: string | null): BadgeVariant {
  if (scope === 'error') return 'destructive';
  if (scope === 'system') return 'secondary';
  return 'outline';
}
function scopeLabel(scope: string | null): string {
  if (scope === 'operation') return '业务操作';
  if (scope === 'error') return '运行错误';
  if (scope === 'system') return '系统';
  if (scope === 'client') return '客户端';
  if (scope === 'notification') return '通知';
  if (scope === 'job') return '任务';
  return scope ?? '-';
}

/** detail 字段安全 JSON 化（用于展示结构化附加信息） */
function stringifyDetail(detail: unknown): string {
  if (detail == null) return '';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => !v && emit('close')">
    <DialogContent class="max-w-3xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>日志详情</DialogTitle>
        <DialogDescription>
          {{ detail ? formatDateTime(detail.created_at) : '加载中…' }}
        </DialogDescription>
      </DialogHeader>

      <div
        v-if="detailLoading"
        class="flex items-center justify-center py-10 text-muted-foreground"
      >
        <Loader2 class="h-5 w-5 animate-spin" />
      </div>

      <div v-else-if="detail" class="space-y-4 text-sm">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">来源</div>
            <Badge :variant="sourceVariant(detail.source)" class="whitespace-nowrap">
              {{ sourceLabel(detail.source) }}
            </Badge>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">级别</div>
            <Badge :variant="levelVariant(detail.level ?? null)">
              {{ levelLabel(detail.level ?? null) }}
            </Badge>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">作用域</div>
            <Badge :variant="scopeVariant(detail.scope ?? null)" class="whitespace-nowrap">
              {{ scopeLabel(detail.scope ?? null) }}
            </Badge>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">模块</div>
            <div class="truncate" :title="detail.module ?? ''">{{ detail.module ?? '-' }}</div>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">用户</div>
            <div class="truncate" :title="detail.user_id ?? ''">
              {{ detail.user_id ?? '系统' }}
            </div>
          </div>
          <div v-if="detail.source === 'notification'">
            <div class="mb-1 text-xs text-muted-foreground">已读</div>
            <div>{{ detail.read ? '已读' : '未读' }}</div>
          </div>
        </div>

        <div>
          <div class="mb-1 text-xs text-muted-foreground">消息</div>
          <div class="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3">
            {{ detail.message ?? '-' }}
          </div>
        </div>

        <div v-if="detail.trace">
          <div class="mb-1 text-xs text-muted-foreground">堆栈</div>
          <pre
            class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs"
          >{{ detail.trace }}</pre>
        </div>

        <div v-if="detail.detail != null">
          <div class="mb-1 text-xs text-muted-foreground">附加信息</div>
          <pre
            class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs"
          >{{ stringifyDetail(detail.detail) }}</pre>
        </div>
      </div>

      <div v-else class="py-10 text-center text-sm text-muted-foreground">
        详情加载失败或不存在
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">关闭</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
