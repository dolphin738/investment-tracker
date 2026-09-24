<script setup lang="ts">
/**
 * modules/admin/components/PendingDividendFilterBar.vue — 待划分分红筛选区
 *
 * 从 PendingDividendsPage 抽出：状态 / 原文标签 / 关键字（250ms 防抖在门面）。
 * filters 为门面下传的同一响应式对象（子组件直改其字段，驱动门面 query 重算）；
 * 状态 / 原文标签变更经 change 上抛（门面据此 page=1 + 清空选中），关键字由门面 watch 防抖；
 * 重置经 reset 上抛。纯展示，无副作用。
 */
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 关键字长度上限（S18）：与后端 `GET /pending-dividends` 的 `q: Query(max_length=50)`
 * **必须一致**——超限时后端直接 422（前端只显示泛化的请求失败，用户不知道是「关键字太长」）。
 * 在输入层拦住是零成本的：粘贴超长串会被截到 50，而不是让整张列表请求失败。
 */
const KEYWORD_MAX_LENGTH = 50;

const props = defineProps<{
  /** 筛选条件（与门面同一响应式对象，子组件直改其字段） */
  filters: { status: string; label: string; q: string };
  /** 原文标签候选集（概览 labels[]） */
  labelOptions: string[];
}>();

const emit = defineEmits<{
  (e: 'change'): void;
  (e: 'reset'): void;
}>();
</script>

<template>
  <Card>
    <CardContent class="flex flex-wrap items-end gap-3 pt-6">
      <div class="space-y-2">
        <Label for="pd-filter-status">状态</Label>
        <select
          id="pd-filter-status"
          class="h-9 w-[140px] rounded-md border border-input bg-background px-2 text-sm"
          :value="props.filters.status"
          @change="
            props.filters.status = ($event.target as HTMLSelectElement).value;
            emit('change');
          "
        >
          <option value="PENDING">待划分</option>
          <option value="ASSIGNED">已划分</option>
          <option value="IGNORED">已忽略</option>
          <option value="">全部</option>
        </select>
      </div>
      <div class="space-y-2">
        <Label for="pd-filter-label">原文标签</Label>
        <select
          id="pd-filter-label"
          class="h-9 w-[160px] rounded-md border border-input bg-background px-2 text-sm"
          :value="props.filters.label"
          @change="
            props.filters.label = ($event.target as HTMLSelectElement).value;
            emit('change');
          "
        >
          <option value="">全部</option>
          <option v-for="l in props.labelOptions" :key="l" :value="l">
            {{ l }}
          </option>
        </select>
      </div>
      <div class="space-y-2">
        <Label for="pd-filter-q">关键字</Label>
        <Input
          id="pd-filter-q"
          :model-value="props.filters.q"
          class="h-9 w-[220px]"
          placeholder="证券代码 / 名称"
          :maxlength="KEYWORD_MAX_LENGTH"
          @update:model-value="(v) => (props.filters.q = String(v))"
        />
      </div>
      <Button variant="outline" @click="emit('reset')">重置</Button>
    </CardContent>
  </Card>
</template>
