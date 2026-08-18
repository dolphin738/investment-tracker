<script setup lang="ts">
/**
 * modules/account/components/PortfolioManagementCard.vue — 我的组合（ACC-P0-04 · 全站唯一组合管理平面）
 *
 * 对齐 React 版 web/src/pages/AccountPage.tsx「我的组合」卡（组合管理平面收敛后的新契约）：
 * - 统一表格 = 业绩列（GET /portfolios/summary）+ 管理列（GET /portfolios 的 description / archivedAt），
 *   前端按 id 合并；summary 为遍历主序（后端已按 createdAt desc 排好）
 * - 管理操作列：设为默认（星标 toggle）/ 编辑 / 归档 / 删除；已归档组合星标 disabled
 * - 点击组合名 = 切换当前组合并跳转概览
 * - 新建 / 编辑走 PortfolioDialog（双模式）；删除走 AlertDialog 二次确认
 * - SYS-P0-05 四态：净值 / 当年% / 更新日为 null 渲染「—」，绝不伪造 0
 * - 组合元信息缺失时按 summary 合成降级对象（描述 -、未归档、按钮仍可点），绝不抛错
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Loader2, Pencil, Plus, Star, Trash2, Archive } from 'lucide-vue-next';
import { useQuery } from '@tanstack/vue-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { getPortfoliosSummary } from '@/api/overview.api';
import {
  useArchivePortfolio,
  useDeletePortfolio,
  usePortfolios,
  useSetDefaultPortfolio,
} from '@/modules/portfolio/composables/use-portfolios';
import { usePreferences } from '@/modules/overview/composables/use-preferences';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { ROUTE_PATH } from '@/lib/constants';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { cn, formatCurrency, formatDate, formatDecimal, formatPercent } from '@/lib/utils';
import PortfolioDialog from '@/modules/portfolio/components/PortfolioDialog.vue';
import type { PortfolioSummary } from '@/api/types';
import type { Portfolio } from '@/lib/types';

/** 无数据统一占位符（SYS-P0-05 四态：null 是「无数据」不是 0） */
const NO_DATA = '—';

/** 统一表格行：业绩字段来自 summary，管理字段来自组合元信息（可降级合成） */
interface PortfolioRow {
  summary: PortfolioSummary;
  meta: Portfolio;
}

const router = useRouter();
const portfolioStore = usePortfolioStore();
const preferenceStore = usePreferenceStore();

const navDecimals = computed(() => preferenceStore.getPreference('navDecimals'));
const xirrDecimals = computed(() => preferenceStore.getPreference('xirrDecimals'));
const amountThousands = computed(() => preferenceStore.getPreference('amountThousands'));
const amountAbbrev = computed(() => preferenceStore.getPreference('amountAbbrev'));

/** 组合管理弹窗状态（[+新建组合] / 编辑 / 删除二次确认） */
const creating = ref(false);
const editing = ref<Portfolio | null>(null);
const deletingId = ref<string | null>(null);

// ── 组合管理数据与 mutation ──
const { data: portfolios } = usePortfolios();
const { data: serverPrefs } = usePreferences();
const deleteMutation = useDeletePortfolio();
const archiveMutation = useArchivePortfolio();
const setDefaultMutation = useSetDefaultPortfolio();

const summary = useQuery({
  queryKey: ['portfolios', 'summary'],
  queryFn: () => getPortfoliosSummary(),
  staleTime: 60 * 1000,
});

/** 当前默认组合 ID（服务端偏好口径；本地 state 承接，让「设为默认」点击后立即高亮星标） */
const defaultPortfolioId = ref('');
watch(
  serverPrefs,
  (prefs) => {
    if (prefs) {
      defaultPortfolioId.value = prefs.defaultPortfolioId ?? '';
    }
  },
  { immediate: true },
);

const isDefaultPortfolio = (portfolioId: string): boolean =>
  defaultPortfolioId.value === portfolioId;

/** 组合元信息索引：id → Portfolio（description / archivedAt 的来源） */
const portfolioMetaMap = computed(() => {
  const map = new Map<string, Portfolio>();
  for (const p of portfolios.value ?? []) {
    map.set(p.id, p);
  }
  return map;
});

/**
 * 统一表格行：以 summary 为遍历主序，逐行补挂管理字段；
 * 缺失时合成降级对象（描述空、未归档），保证操作列不崩。
 */
const portfolioRows = computed<PortfolioRow[]>(() => {
  const data = summary.data.value;
  if (!data) return [];
  return data.map((s) => {
    const meta = portfolioMetaMap.value.get(s.id);
    if (meta) {
      return { summary: s, meta };
    }
    const fallback: Portfolio = {
      id: s.id,
      userId: '',
      name: s.name,
      description: null,
      baseDate: s.baseDate,
      currency: s.currency,
      archivedAt: null,
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
    };
    return { summary: s, meta: fallback };
  });
});

/** 点击组合行：切换当前组合并跳转概览（ACC-P0-04） */
function handleOpenPortfolio(portfolioId: string): void {
  if (portfolioId !== portfolioStore.currentPortfolioId) {
    portfolioStore.setCurrentPortfolio(portfolioId);
  }
  router.push(ROUTE_PATH.DASHBOARD);
}

/**
 * 设为默认 / 取消默认（toggle · SET-P0-06）：后端已是默认则取消、否则设为默认。
 * 成功后本地 defaultPortfolioId 对齐返回值，星标立即同步；已归档组合不能设为默认。
 */
function handleSetDefaultPortfolio(portfolio: Portfolio): void {
  if (portfolio.archivedAt) {
    return;
  }
  setDefaultMutation.mutate(portfolio.id, {
    onSuccess: (pref) => {
      defaultPortfolioId.value = pref.defaultPortfolioId ?? '';
    },
  });
}

/** 删除二次确认后的实际删除 */
function handleConfirmDelete(): void {
  const id = deletingId.value;
  if (id) {
    deleteMutation.mutate(id, {
      onSettled: () => (deletingId.value = null),
    });
  }
}

function closeDialog(): void {
  creating.value = false;
  editing.value = null;
}

/**
 * 删除确认弹窗关闭处理。
 *
 * reka-ui AlertDialogAction（内部 DialogClose）的关闭 handler 与用户 @click 按
 * [reka, user] 顺序合并执行：reka 先 onOpenChange(false) 再跑用户 handler。
 * 故「清空 deletingId」必须延迟到微任务，否则用户确认 handler 执行时 id 已被清空，
 * 删除 mutation 拿不到参数（对齐 React/Radix 的用户 handler 先执行语义）。
 */
function handleDeleteDialogOpenChange(o: boolean): void {
  if (!o) {
    queueMicrotask(() => (deletingId.value = null));
  }
}
</script>

<template>
  <Card>
    <CardHeader class="flex-row items-center justify-between">
      <CardTitle class="text-base">我的组合</CardTitle>
      <!-- INC-05：与全站录入入口同规格（主色 sm + Plus），文案取自统一字典 -->
      <Button
        :size="ENTRY_BUTTON_SIZE"
        :variant="ENTRY_BUTTON_VARIANT"
        @click="creating = true"
      >
        <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
        {{ ENTRY_BUTTON_LABELS.portfolio }}
      </Button>
    </CardHeader>
    <CardContent>
      <!-- 加载骨架 -->
      <div v-if="summary.isLoading.value" class="space-y-2">
        <div v-for="i in 3" :key="i" class="h-9 animate-pulse rounded bg-muted" />
      </div>
      <template v-else-if="portfolioRows.length > 0">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>组合名称</TableHead>
                <TableHead>描述</TableHead>
                <TableHead>成立日</TableHead>
                <TableHead>币种</TableHead>
                <TableHead class="text-right">最新总资产</TableHead>
                <TableHead class="text-right">净值</TableHead>
                <TableHead class="text-right">当年%</TableHead>
                <TableHead>更新日</TableHead>
                <TableHead class="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="{ summary: p, meta } in portfolioRows" :key="p.id">
                <TableCell class="font-medium">
                  <span class="inline-flex items-center gap-2">
                    <button
                      type="button"
                      class="text-left hover:underline"
                      :title="'切换到该组合并跳转概览'"
                      @click="handleOpenPortfolio(p.id)"
                    >
                      <span
                        v-if="p.id === portfolioStore.currentPortfolioId"
                        class="font-semibold text-primary"
                      >
                        {{ p.name }}
                      </span>
                      <span v-else>{{ p.name }}</span>
                    </button>
                    <span v-if="meta.archivedAt" class="text-xs text-muted-foreground">
                      已归档
                    </span>
                  </span>
                </TableCell>
                <!-- 描述：来自组合元信息；缺失时降级为 '-' -->
                <TableCell class="text-sm text-muted-foreground">
                  {{ meta.description || '-' }}
                </TableCell>
                <!-- 成立日 = 首笔存入日（FIN-D6）：无存入记录时显示「未成立」，不冒充创建日 -->
                <TableCell class="text-sm">
                  <span v-if="p.baseDate">{{ formatDate(p.baseDate) }}</span>
                  <span v-else class="text-muted-foreground" title="成立日 = 首笔存入日（FIN-D6）；该组合尚无存入记录">
                    未成立<br />
                    <span class="text-[11px]">创建于 {{ formatDate(p.createdAt) }}</span>
                  </span>
                </TableCell>
                <TableCell class="text-sm">{{ p.currency }}</TableCell>
                <TableCell class="text-right tabular-nums">
                  {{ formatCurrency(p.totalAsset || '0', 2, { thousands: amountThousands, abbreviate: amountAbbrev }) }}
                </TableCell>
                <!-- 净值：累计净值，null = 尚无 DailyNav -->
                <TableCell class="text-right tabular-nums text-muted-foreground">
                  {{ p.cumulativeNav != null ? formatDecimal(p.cumulativeNav, navDecimals) : NO_DATA }}
                </TableCell>
                <!-- 当年%：后端给比率（0.0523 = 5.23%），formatPercent 内部 ×100；正负着色按比率符号 -->
                <TableCell
                  :class="p.yearReturnRate != null
                    ? Number(p.yearReturnRate) >= 0
                      ? 'text-right tabular-nums text-up'
                      : 'text-right tabular-nums text-down'
                    : 'text-right tabular-nums text-muted-foreground'"
                >
                  {{ p.yearReturnRate != null ? formatPercent(p.yearReturnRate, 2, { decimals: xirrDecimals }) : NO_DATA }}
                </TableCell>
                <TableCell class="font-mono text-sm">
                  {{ p.lastUpdatedAt ? formatDate(p.lastUpdatedAt) : NO_DATA }}
                </TableCell>
                <!-- 管理操作列（自设置页组合管理原样迁移：文案 / title / disabled 逐项对齐） -->
                <TableCell class="text-right">
                  <div class="flex justify-end gap-1">
                    <!-- 设为默认 / 取消默认（toggle · SET-P0-06） -->
                    <Button
                      size="icon"
                      variant="ghost"
                      :title="meta.archivedAt
                        ? '已归档组合不能设为默认'
                        : isDefaultPortfolio(p.id) ? '取消默认' : '设为默认'"
                      :aria-label="isDefaultPortfolio(p.id) ? '取消默认' : '设为默认'"
                      :disabled="Boolean(meta.archivedAt) || setDefaultMutation.isPending.value"
                      @click="handleSetDefaultPortfolio(meta)"
                    >
                      <Star
                        :class="cn(
                          'h-4 w-4',
                          isDefaultPortfolio(p.id) ? 'fill-primary text-primary' : '',
                        )"
                      />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="编辑"
                      aria-label="编辑"
                      @click="editing = meta"
                    >
                      <Pencil class="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      :title="meta.archivedAt ? '取消归档' : '归档'"
                      :aria-label="meta.archivedAt ? '取消归档' : '归档'"
                      :disabled="archiveMutation.isPending.value"
                      @click="archiveMutation.mutate({ id: p.id, archived: !meta.archivedAt })"
                    >
                      <Archive
                        :class="cn('h-4 w-4', meta.archivedAt ? 'text-primary' : '')"
                      />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="删除"
                      aria-label="删除"
                      @click="deletingId = p.id"
                    >
                      <Trash2 class="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p class="mt-3 space-y-1 text-xs text-muted-foreground">
          点击组合名称可切换当前组合并跳转概览；右侧操作列可设为默认 / 编辑 / 归档 / 删除
          <br />
          <Star class="mr-0.5 inline h-3 w-3 text-amber-500" /> 设为默认：登录后自动选中该组合（写入偏好 defaultPortfolioId）；已归档组合不能设为默认
        </p>
      </template>
      <div v-else class="py-8 text-center text-sm text-muted-foreground">
        暂无组合，点击右上角「新建组合」开始
      </div>
    </CardContent>

    <!-- 新建 / 编辑组合对话框（同一组件双模式：portfolio 非空即编辑） -->
    <PortfolioDialog
      :open="creating || Boolean(editing)"
      :portfolio="editing"
      @open-change="(o) => !o && closeDialog()"
    />

    <!-- 删除组合确认（二次确认，文案自设置页原样迁移；关闭时序见 handleDeleteDialogOpenChange） -->
    <AlertDialog
      :open="Boolean(deletingId)"
      @update:open="handleDeleteDialogOpenChange"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除该组合？</AlertDialogTitle>
          <AlertDialogDescription>
            删除组合将级联删除其下所有交易、快照、净值与 XIRR 数据，此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleteMutation.isPending.value">
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="deleteMutation.isPending.value"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="handleConfirmDelete"
          >
            <Loader2 v-if="deleteMutation.isPending.value" class="mr-2 h-4 w-4 animate-spin" />
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>
</template>
