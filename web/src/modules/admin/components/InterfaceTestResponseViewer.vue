<script setup lang="ts">
/**
 * modules/admin/components/InterfaceTestResponseViewer.vue
 *
 * 平移自 InterfaceTestPanel.vue 的结果展示区块（状态 / 错误 / 逐槽位命中率
 * / 原始响应），属于纯位置拆分，行为契约与父组件完全一致。
 * 原始响应支持查找高亮 / 上下跳转 / 复制全部。
 *
 * findQuery / currentMatch 由父级（InterfaceTestPanel）通过 v-model 下发：
 * 父级在 handleTest 时负责重置这两个查找态，本组件只消费并回写。
 */

import { computed, nextTick, ref, watch } from 'vue';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Search,
  X,
} from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { InterfaceTestResponse } from '@/api/quote-interface.api';

const props = defineProps<{
  /** 测试结果（与父级 InterfaceTestPanel 同引用） */
  result: InterfaceTestResponse | null;
  /** 查找词（v-model，父级持有并在 handleTest 时重置） */
  findQuery: string;
  /** 当前命中序号（v-model，父级持有并在 handleTest 时重置） */
  currentMatch: number;
}>();
const emit = defineEmits<{
  'update:findQuery': [value: string];
  'update:currentMatch': [value: number];
}>();

/** 未知结构安全序列化（避免循环引用等导致 JSON.stringify 抛错） */
function safeStringify(v: unknown): string {
  // JSON.stringify(undefined) 会返回 undefined（非法 string），此处兜底为 ''，
  // 避免上游接口测试的 raw 缺失时，渲染层读取 rawText.length 崩溃。
  if (v === undefined) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const rawText = computed(() =>
  props.result ? safeStringify(props.result.raw) : '',
);

/** 查询词在 rawText 中全部命中位置（大小写不敏感） */
const matchIndices = computed(() => {
  if (!props.findQuery) return [];
  const q = props.findQuery.toLowerCase();
  // 小写化提出循环：避免每次命中都重复全文 toLowerCase（O(命中数×全文长度)）
  const lower = rawText.value.toLowerCase();
  const idxs: number[] = [];
  let i = lower.indexOf(q);
  while (i !== -1) {
    idxs.push(i);
    i = lower.indexOf(q, i + q.length);
  }
  return idxs;
});

/** 高亮当前命中并滚动到可视区（mark 元素顺序即命中顺序） */
function highlightRef(el: Element | null): void {
  if (!el) return;
  if (!props.findQuery || matchIndices.value.length === 0) return;
  const marks = el.querySelectorAll('mark');
  const target =
    marks[Math.min(props.currentMatch, matchIndices.value.length - 1)];
  target?.scrollIntoView({ block: 'center' });
}
watch(
  () => [props.findQuery, props.currentMatch, matchIndices.value.length],
  () => {
    nextTick(() => {
      const pre = preRef.value;
      if (!pre) return;
      const marks = pre.querySelectorAll('mark');
      const target =
        marks[Math.min(props.currentMatch, matchIndices.value.length - 1)];
      target?.scrollIntoView({ block: 'center' });
    });
  },
);

const preRef = ref<HTMLElement | null>(null);

function jumpMatch(dir: 1 | -1): void {
  if (matchIndices.value.length === 0) return;
  const next =
    (props.currentMatch + dir + matchIndices.value.length) %
    matchIndices.value.length;
  emit('update:currentMatch', next);
}

async function handleCopyAll(): Promise<void> {
  try {
    await navigator.clipboard.writeText(rawText.value);
    toast.success('原始响应已复制');
  } catch {
    toast.error('复制失败，请手动选择复制');
  }
}

/** 按查询词切分文本并返回高亮片段数组（空查询原样返回） */
function highlightSegments(text: string, query: string): Array<{ text: string; hit: boolean }> {
  if (!query) return [{ text, hit: false }];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return parts;
}
</script>

<template>
  <div v-if="result" class="space-y-3 rounded-md border p-3">
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <Badge :variant="result.status === 'success' ? 'success' : 'secondary'">
        {{ result.status === 'success' ? '成功' : '失败' }}
      </Badge>
      <span class="text-muted-foreground">耗时 {{ result.elapsedMs }}ms</span>
      <span v-if="result.httpStatus != null" class="text-muted-foreground">
        HTTP {{ result.httpStatus }}
      </span>
    </div>

    <p v-if="result.error" class="text-sm text-red-500">{{ result.error }}</p>

    <!-- 逐槽位命中率（fieldHits）：替代旧的 parsed 两列渲染（边界 11） -->
    <div v-if="result.fieldHits && result.fieldHits.length > 0">
      <div class="mb-1 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>逐槽位命中率</span>
        <Badge v-if="result.rowCount != null" variant="outline">
          {{ result.rowCount }} 行
        </Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>槽位</TableHead>
            <TableHead>字段</TableHead>
            <TableHead>中文</TableHead>
            <TableHead class="text-right">命中</TableHead>
            <TableHead class="text-right">缺失</TableHead>
            <TableHead>示例</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="hit in result.fieldHits" :key="hit.key">
            <TableCell class="font-mono">{{ hit.slot }}</TableCell>
            <TableCell class="font-mono">{{ hit.key }}</TableCell>
            <TableCell>{{ hit.label ?? hit.key }}</TableCell>
            <TableCell class="text-right font-mono">{{ hit.hit }}</TableCell>
            <TableCell
              class="text-right font-mono"
              :class="hit.missing > 0 ? 'text-red-500' : 'text-muted-foreground'"
            >
              {{ hit.missing }}
            </TableCell>
            <TableCell class="max-w-[16rem] truncate font-mono text-xs" :title="hit.sample ?? ''">
              {{ hit.sample ?? '—' }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <p
      v-else-if="result.status === 'success'"
      class="text-xs text-muted-foreground"
    >
      无命中率数据（接口无有效映射或取数为空）
    </p>

    <div>
      <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted-foreground">
          原始响应（{{ rawText.length.toLocaleString() }} 字符）
        </span>
        <div class="flex items-center gap-2">
          <div class="flex items-center gap-1 rounded-md border px-2 py-1">
            <Search class="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              :value="findQuery"
              placeholder="查找"
              class="h-6 w-24 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              @input="(e) => { emit('update:findQuery', (e.target as HTMLInputElement).value); emit('update:currentMatch', 0); }"
              @keydown.enter="(e) => { e.preventDefault(); jumpMatch((e as KeyboardEvent).shiftKey ? -1 : 1); }"
            />
            <button
              v-if="findQuery"
              type="button"
              aria-label="清除查找"
              class="rounded p-0.5 text-muted-foreground hover:bg-muted"
              @click="() => { emit('update:findQuery', ''); emit('update:currentMatch', 0); }"
            >
              <X class="h-3.5 w-3.5" />
            </button>
            <span
              v-if="findQuery && matchIndices.length > 0"
              class="whitespace-nowrap text-xs text-muted-foreground"
            >
              {{ currentMatch + 1 }}/{{ matchIndices.length }}
            </span>
            <span
              v-if="findQuery && matchIndices.length === 0"
              class="whitespace-nowrap text-xs text-red-500"
            >
              0
            </span>
            <div class="flex items-center">
              <button
                type="button"
                title="上一个（Shift+Enter）"
                :disabled="matchIndices.length === 0"
                class="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                @click="jumpMatch(-1)"
              >
                <ChevronUp class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="下一个（Enter）"
                :disabled="matchIndices.length === 0"
                class="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                @click="jumpMatch(1)"
              >
                <ChevronDown class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <Button variant="outline" size="sm" @click="handleCopyAll">
            <Copy class="mr-1 h-3.5 w-3.5" />
            复制全部
          </Button>
        </div>
      </div>
      <pre
        ref="preRef"
        class="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
      >
        <template v-for="(seg, i) in highlightSegments(rawText, findQuery)" :key="i">
          <mark v-if="seg.hit" class="rounded-sm bg-yellow-300 px-0 text-black">
            {{ seg.text }}
          </mark>
          <template v-else>{{ seg.text }}</template>
        </template>
      </pre>
    </div>
  </div>
</template>
