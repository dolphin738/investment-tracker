<script setup lang="ts">
/**
 * components/DividendDetailCard.vue — 分红明细折叠卡（平移自 DividendList.vue）
 *
 * [分红记录 ▾] 折叠开关 + 明细表（R-3：三列 金额/所得税/净额 + 编辑入口；I-02 tax/type 修复）。
 * 展开状态（open）由门面 dividendOpen 经 v-model:open 下传，点击切换经 update:open 上抛；
 * 明细数据（dividendList）与金额格式偏好（moneyOpts）由门面以 props 下传；
 * 编辑 / 删除交互经 edit / delete 事件上抛，由门面既有处理函数（editing / requestDelete）承接。
 * useDividends 等数据拉取保留在门面，本组件不发起任何请求（避免挂载死锁）。
 * 纯位置拆分：文案、类名、绑定与拆分前逐字节等价。
 */

import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DIVIDEND_TYPE_LABEL } from '../composables/use-dividends';
import { formatCurrency, formatDate, type FormatCurrencyOptions } from '@/lib/utils';
import type { DividendRecord } from '@/api/types';

const props = defineProps<{
  /** 折叠展开状态（门面 dividendOpen，v-model:open） */
  open: boolean;
  /** 分红明细列表 */
  dividendList: DividendRecord[];
  /** 金额格式偏好（千分位 / 缩写，门面自 preference store 派生） */
  moneyOpts: FormatCurrencyOptions;
}>();

const emit = defineEmits<{
  /** 切换折叠状态（门面写回 dividendOpen） */
  'update:open': [open: boolean];
  /** 行内编辑 → 门面置 editing 打开编辑弹窗 */
  edit: [item: DividendRecord];
  /** 行内删除 → 门面 requestDelete 打开确认弹窗 */
  delete: [id: string];
}>();

function handleToggle(): void {
  emit('update:open', !props.open);
}
</script>

<template>
  <Card>
    <CardContent class="p-0">
      <button
        type="button"
        class="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50"
        :aria-expanded="open"
        @click="handleToggle"
      >
        <span class="flex items-center gap-2">
          <ChevronDown v-if="open" class="h-4 w-4" />
          <ChevronRight v-else class="h-4 w-4" />
          分红记录
          <Badge variant="secondary" class="text-xs">{{ dividendList.length }}</Badge>
        </span>
      </button>

      <div v-if="open" class="overflow-x-auto border-t">
        <p v-if="dividendList.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
          暂无分红记录
        </p>
        <Table v-else data-testid="dividend-detail-table">
          <TableHeader>
            <TableRow>
              <TableHead class="sticky left-0 z-10 bg-background">日期</TableHead>
              <TableHead class="sticky left-0 z-10 bg-background">标的</TableHead>
              <TableHead>类型</TableHead>
              <TableHead class="text-right">金额</TableHead>
              <TableHead class="text-right">所得税</TableHead>
              <TableHead class="text-right">净额</TableHead>
              <TableHead>备注</TableHead>
              <TableHead class="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="item in dividendList" :key="item.id">
              <TableCell class="sticky left-0 z-10 bg-background tabular-nums">{{ formatDate(item.date) }}</TableCell>
              <TableCell>
                {{ item.securityName }}
                <span class="ml-1 text-xs text-muted-foreground">{{ item.securityCode }}</span>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" class="text-xs">
                  {{ DIVIDEND_TYPE_LABEL[item.type] ?? item.type }}
                </Badge>
              </TableCell>
              <TableCell class="text-right tabular-nums text-up">
                {{ formatCurrency(item.amount, 2, moneyOpts) }}
              </TableCell>
              <TableCell class="text-right tabular-nums text-muted-foreground">
                {{ formatCurrency(item.tax ?? '0', 2, moneyOpts) }}
              </TableCell>
              <TableCell class="text-right tabular-nums text-up">
                {{ formatCurrency(Number(item.amount) - Number(item.tax ?? 0), 2, moneyOpts) }}
              </TableCell>
              <TableCell class="max-w-[200px] truncate text-muted-foreground">
                {{ item.note ?? '-' }}
              </TableCell>
              <TableCell class="text-right">
                <div class="flex justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="编辑分红记录"
                    title="编辑"
                    @click="emit('edit', item)"
                  >
                    <Pencil class="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="删除分红记录"
                    title="删除"
                    class="text-destructive"
                    @click="emit('delete', item.id)"
                  >
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </CardContent>
  </Card>
</template>
