/**
 * modules/admin/composables/use-pending-batch.ts — 待划分分红的**批量编排**（S17 自门面抽出）
 *
 * 收口三件事：批量采纳建议 / 批量忽略（含行内单笔忽略）的**确认弹窗态**、**结果态**
 * （`{succeeded, failed[]}`）与「失败行保持选中便于重试」的重试契约，以及采纳前预览。
 * 门面（PendingDividendsPage）只保留列表、筛选、选中集与单笔「指定」表单。
 *
 * 为什么值得抽出：这块是全页最绕的交互（部分失败 → 红条 + 保持选中 → 重试），
 * 抽成 composable 后可被测试直接驱动（S16 的用例即打在门面 + 本 composable 上），
 * 同时让门面回到 400 行以内（§4「存量超限文件禁止继续增长」）。
 *
 * 约定：mutation 的 toast 文案仍由本模块给出（与既有「hook 不弹 toast、由调用方区分文案」
 * 的约定相反，但批量成功/部分失败的文案与结果态强绑定，放在一起才有单一真相源）。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { toast } from '@/composables/use-toast';
import type { components } from '@/types/api';
import type { PendingAssignItemPayload } from '@/api/dividend-yield.api';
import { PERIOD_TYPE_LABELS } from '@/modules/dividend-yield/lib/suggest-report-period';
import {
  suggestionPayload,
  type BatchFailedItem,
} from '@/modules/dividend-yield/lib/pending-dividends';
import {
  useBatchAssignPendingDividends,
  useBatchIgnorePendingDividends,
  useIgnorePendingDividend,
} from '@/modules/dividend-yield/composables/use-pending-dividends';

type PendingDividendOut = components['schemas']['PendingDividendOut'];

export function usePendingDividendBatch(options: {
  /** 选中集（门面持有；批量结果据此「保留失败行」/「清空」/「摘掉单笔」） */
  selectedIds: Ref<Set<string>>;
  /** 选中行（门面已按「可勾选」过滤） */
  selectedRows: ComputedRef<PendingDividendOut[]>;
  /** 忽略目标 id：行内=该行 1 个；批量条=勾选集（弹窗读它显示计数，故仍由门面持有） */
  ignoreTargets: Ref<string[]>;
}) {
  const { selectedIds, selectedRows, ignoreTargets } = options;

  /** 整批成功 → 清空选中 */
  function clearSelection(): void {
    selectedIds.value = new Set();
  }
  /** 失败行保持选中便于重试 */
  function retainSelection(ids: string[]): void {
    selectedIds.value = new Set(ids);
  }
  /** 单笔操作成功 → 只摘掉该行，不影响其余勾选 */
  function removeFromSelection(id: string): void {
    const n = new Set(selectedIds.value);
    n.delete(id);
    selectedIds.value = n;
  }

  const batchAssignMut = useBatchAssignPendingDividends();
  const batchIgnoreMut = useBatchIgnorePendingDividends();
  const ignoreMut = useIgnorePendingDividend();

  const confirmOpen = ref(false);
  const confirmMode = ref<'assign' | 'ignore'>('assign');
  const lastBatchFailed = ref<BatchFailedItem[]>([]);
  const lastBatchSucceeded = ref(0);

  /** 有建议候选的选中行（采纳建议只覆盖这些；无候选行跳过） */
  const adoptablePayloads = computed<PendingAssignItemPayload[]>(() =>
    selectedRows.value
      .map(suggestionPayload)
      .filter((x): x is PendingAssignItemPayload => x !== null),
  );
  const skippedNoCandidate = computed(
    () => selectedRows.value.length - adoptablePayloads.value.length,
  );
  const assignPreview = computed(() =>
    selectedRows.value
      .map((r) => ({ r, p: suggestionPayload(r) }))
      .filter(
        (x): x is { r: PendingDividendOut; p: PendingAssignItemPayload } => x.p !== null,
      )
      .slice(0, 3)
      .map(
        ({ r, p }) =>
          `${r.code || r.masterId} ${p.reportYear}Q${p.reportQuarter} ${
            PERIOD_TYPE_LABELS[p.periodType as keyof typeof PERIOD_TYPE_LABELS] ?? '其他'
          }`,
      ),
  );

  function openBatchAssign(): void {
    if (adoptablePayloads.value.length === 0) return;
    confirmMode.value = 'assign';
    confirmOpen.value = true;
  }

  function openBatchIgnore(): void {
    if (selectedRows.value.length === 0) return;
    ignoreTargets.value = selectedRows.value.map((r) => r.id);
    confirmMode.value = 'ignore';
    confirmOpen.value = true;
  }

  /**
   * 行内「忽略」：只忽略被点击的这一行。
   *
   * 此前该按钮 `emit('ignore', row)` 绑定的却是无参批量处理函数 → row 被静默丢弃，
   * 表现为「未勾选时点了没反应」/「有勾选时忽略的是整个勾选集而非被点行」。忽略不可撤销，
   * 故单行走单笔端点（`useIgnorePendingDividend`），语义与失败提示都更准确。
   */
  function openRowIgnore(row: PendingDividendOut): void {
    ignoreTargets.value = [row.id];
    confirmMode.value = 'ignore';
    confirmOpen.value = true;
  }

  function handleBatchResult(
    action: string,
    data: { succeeded: number; failed?: BatchFailedItem[] },
  ): void {
    lastBatchSucceeded.value = data.succeeded;
    lastBatchFailed.value = data.failed ?? [];
    if (lastBatchFailed.value.length > 0) {
      toast.warning(
        `${action}：成功 ${data.succeeded} 笔、失败 ${lastBatchFailed.value.length} 笔`,
      );
    } else {
      toast.success(`${action}：全部成功（${data.succeeded} 笔）`);
    }
  }

  function confirmBatch(): void {
    confirmOpen.value = false;
    if (confirmMode.value === 'assign') {
      batchAssignMut.mutate(adoptablePayloads.value, {
        onSuccess: (data) => {
          handleBatchResult('采纳建议', data);
          clearSelection();
        },
        onError: () => toast.error('批量采纳失败，请稍后重试'),
      });
      return;
    }
    const ids = ignoreTargets.value;
    if (ids.length === 0) return;
    // 单笔（行内按钮）走单笔端点：语义清晰、失败原因更准确；多笔走批量端点（逐项报错）
    if (ids.length === 1) {
      const only = ids[0];
      ignoreMut.mutate(only, {
        onSuccess: () => {
          // 只摘掉这一行，不清空其余勾选（点行内按钮不该影响勾选集）
          removeFromSelection(only);
          ignoreTargets.value = [];
          toast.success('已忽略（未写入分红主表）');
        },
        onError: () => toast.error('忽略失败，请稍后重试'),
      });
      return;
    }
    batchIgnoreMut.mutate(ids, {
      onSuccess: (data) => {
        handleBatchResult('忽略', data);
        ignoreTargets.value = [];
        clearSelection();
      },
      onError: () => toast.error('批量忽略失败，请稍后重试'),
    });
  }

  /** 失败行保持选中便于重试（已成功的行从选中集移除） */
  watch(lastBatchFailed, (failed) => {
    if (failed.length === 0) return;
    retainSelection(failed.map((f) => f.id));
  });

  return {
    confirmOpen,
    confirmMode,
    lastBatchFailed,
    lastBatchSucceeded,
    adoptablePayloads,
    skippedNoCandidate,
    assignPreview,
    batchAssignPending: computed(() => batchAssignMut.isPending.value),
    batchIgnorePending: computed(() => batchIgnoreMut.isPending.value),
    openBatchAssign,
    openBatchIgnore,
    openRowIgnore,
    confirmBatch,
  };
}
