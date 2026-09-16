<script setup lang="ts">
/**
 * modules/admin/components/LogCenterFilterBar.vue — 日志中心筛选区
 *
 * 从 LogCenterPage 抽出：级别/作用域/模块/关键字/起止日期筛选 + 查询/重置/跨页全选/
 * 已选计数/批量删除入口。filters 为门面下传的同一响应式对象（v-model 直改其字段，
 * 以驱动门面 query 重算）；selectAll / selectedIds / selectedPages 为门面下传只读态，
 * 跨页全选切换经 update:select-all 上抛，由门面统一写回。纯位置性拆分，零行为变更。
 */
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search, RotateCcw, Trash2 } from 'lucide-vue-next';

const props = defineProps<{
  /** 筛选条件（与门面同一响应式对象，子组件直改其字段） */
  filters: {
    level: string;
    scope: string;
    module: string;
    keyword: string;
    startDate: string;
    endDate: string;
  };
  /** 是否管理员（控制跨页全选 / 批量删除入口可见性） */
  isAdmin: boolean;
  /** 跨页全选态（读 + 经 update:select-all 上抛写回） */
  selectAll: boolean;
  /** 当前筛选结果总数 */
  total: number;
  /** 已选行 id 集合（读 .size） */
  selectedIds: Set<string>;
  /** 已选行所在页集合（读 .size） */
  selectedPages: Set<number>;
}>();

const emit = defineEmits<{
  (e: 'search'): void;
  (e: 'reset'): void;
  (e: 'batch-delete'): void;
  (e: 'update:select-all', v: boolean): void;
}>();

const LEVEL_OPTIONS = [
  { value: 'all', label: '全部级别' },
  { value: 'error', label: '错误' },
  { value: 'warning', label: '警告' },
  { value: 'info', label: '信息' },
] as const;

const SCOPE_OPTIONS = [
  { value: 'all', label: '全部作用域' },
  { value: 'operation', label: '业务操作' },
  { value: 'error', label: '运行错误' },
  { value: 'system', label: '系统' },
] as const;
</script>

<template>
  <Card>
    <CardContent class="space-y-4 pt-6">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <div class="space-y-2">
          <Label>级别</Label>
          <Select v-model="filters.level">
            <SelectTrigger><SelectValue placeholder="全部级别" /></SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="opt in LEVEL_OPTIONS"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-2">
          <Label>作用域</Label>
          <Select v-model="filters.scope">
            <SelectTrigger><SelectValue placeholder="全部作用域" /></SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="opt in SCOPE_OPTIONS"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-2">
          <Label for="log-module">模块</Label>
          <Input id="log-module" v-model="filters.module" placeholder="如 scheduler / api" />
        </div>

        <div class="space-y-2">
          <Label for="log-keyword">关键字</Label>
          <Input id="log-keyword" v-model="filters.keyword" placeholder="匹配消息内容" />
        </div>

        <div class="space-y-2">
          <Label for="log-start">开始日期</Label>
          <Input id="log-start" v-model="filters.startDate" type="date" />
        </div>

        <div class="space-y-2">
          <Label for="log-end">结束日期</Label>
          <Input id="log-end" v-model="filters.endDate" type="date" />
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" @click="emit('search')">
            <Search class="mr-1 h-4 w-4" />
            查询
          </Button>
          <Button size="sm" variant="outline" @click="emit('reset')">
            <RotateCcw class="mr-1 h-4 w-4" />
            重置
          </Button>
          <!-- 跨页全选：紧挨「重置」（仅管理员可见，选中态不显示当页全选入口） -->
          <Button
            v-if="isAdmin && !selectAll"
            variant="link"
            size="sm"
            class="px-0 text-muted-foreground"
            @click="emit('update:select-all', true)"
          >
            全选全部 {{ total }} 条（跨页）
          </Button>
          <span
            v-if="!selectAll && selectedIds.size > 0"
            class="shrink-0 text-xs text-muted-foreground"
          >
            已选 {{ selectedIds.size }} 条
            <template v-if="selectedPages.size > 1">（跨 {{ selectedPages.size }} 页）</template>
          </span>
          <!-- 跨页全选提示条：紧跟「全选全部」（仅管理员下全选后显示） -->
          <div
            v-if="isAdmin && selectAll"
            class="flex shrink-0 items-center gap-2 rounded-md border border-dashed bg-muted/40 px-2 py-1 text-sm"
          >
            <span>已全选全部 {{ total }} 条日志（跨所有页，应用当前筛选条件）</span>
            <Button
              variant="link"
              size="sm"
              class="px-0"
              @click="emit('update:select-all', false)"
            >
              取消全选
            </Button>
          </div>
        </div>
        <!-- 删除：置顶一行最右侧（仅管理员显示） -->
        <Button
          v-if="isAdmin"
          variant="outline"
          size="sm"
          :disabled="!selectAll && selectedIds.size === 0"
          class="shrink-0 text-red-600 hover:text-red-700"
          @click="emit('batch-delete')"
        >
          <Trash2 class="mr-1 h-3.5 w-3.5" />
          删除({{ selectAll ? total : selectedIds.size }})
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
