<script setup lang="ts">
/**
 * components/common/Pagination.vue — 统一分页控件
 *
 * 设计规范（全站列表页一致）：
 * - 布局：顶部 border-t 分隔线 + pt-3 间距；左侧总数文案、右侧操作区两端对齐。
 * - 配色：总数文案 text-xs text-muted-foreground；按钮统一 variant="outline" size="sm"。
 * - 交互态：禁用态(首/末页/上一页/下一页边界由 :disabled 控制) + hover/focus 由 Button 组件统一。
 * - 文案：统一「共 N 条 · 第 X/Y 页」。
 *
 * 能力开关：
 * - pageSizeOptions：传入则在左侧追加「每页条数」Select（如出入金页 20/50/100）。
 * - showFirstLast：是否显示首页/末页按钮（如证券列表）。
 * - showJumper：是否显示「跳至第 N 页」输入框（如证券列表）。
 *
 * 所有页码变更通过事件上抛，分页状态(是否受控)由使用方持有，本组件不内置页码。
 */
import { computed } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const props = withDefaults(
  defineProps<{
    /** 当前页码（从 1 开始） */
    page: number;
    /** 总页数（>=1） */
    totalPages: number;
    /** 总条数 */
    total: number;
    /** 每页条数（用于「每页条数」Select 回显；不传则不显示该 Select） */
    pageSize?: number;
    /** 「每页条数」可选项；传空数组 = 不显示 */
    pageSizeOptions?: readonly number[];
    /** 是否显示首页/末页按钮 */
    showFirstLast?: boolean;
    /** 是否显示「跳至第 N 页」输入框 */
    showJumper?: boolean;
  }>(),
  {
    pageSize: undefined,
    pageSizeOptions: () => [],
    showFirstLast: false,
    showJumper: false,
  },
);

const emit = defineEmits<{
  pageChange: [page: number];
  pageSizeChange: [pageSize: number];
}>();

const atFirst = computed(() => props.page <= 1);
const atLast = computed(() => props.page >= props.totalPages);

function go(target: number): void {
  const clamped = Math.min(props.totalPages, Math.max(1, target));
  if (clamped !== props.page) emit('pageChange', clamped);
}

function handlePageSizeChange(v: string): void {
  emit('pageSizeChange', Number(v));
}
</script>

<template>
  <div
    class="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground"
  >
    <!-- 左侧：总数文案 + 可选每页条数 -->
    <div class="flex flex-wrap items-center gap-2">
      <span>共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
      <Select
        v-if="pageSizeOptions.length > 0 && pageSize != null"
        :model-value="String(pageSize)"
        @update:model-value="handlePageSizeChange"
      >
        <SelectTrigger class="h-8 w-[92px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in pageSizeOptions"
            :key="opt"
            :value="String(opt)"
          >
            {{ opt }} / 页
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- 右侧：操作区 -->
    <div class="flex flex-wrap items-center gap-1">
      <template v-if="showFirstLast">
        <Button
          variant="outline"
          size="sm"
          :disabled="atFirst"
          @click="go(1)"
        >
          首页
        </Button>
      </template>
      <Button
        variant="outline"
        size="sm"
        :disabled="atFirst"
        @click="go(page - 1)"
      >
        <ChevronLeft class="h-4 w-4" />
        上一页
      </Button>
      <span class="px-1 tabular-nums">{{ page }} / {{ totalPages }}</span>
      <Button
        variant="outline"
        size="sm"
        :disabled="atLast"
        @click="go(page + 1)"
      >
        下一页
        <ChevronRight class="h-4 w-4" />
      </Button>
      <template v-if="showFirstLast">
        <Button
          variant="outline"
          size="sm"
          :disabled="atLast"
          @click="go(totalPages)"
        >
          末页
        </Button>
      </template>
      <div v-if="showJumper" class="ml-1 flex items-center gap-1">
        <span>跳至</span>
        <Input
          type="number"
          min="1"
          :max="totalPages"
          :model-value="page"
          class="h-8 w-16 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          placeholder="页"
          @update:model-value="(v: string | number) => go(Number(v))"
        />
        <span>页</span>
      </div>
    </div>
  </div>
</template>
