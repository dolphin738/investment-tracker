/**
 * modules/snapshot/__tests__/snapshot-list-row-actions.test.ts — 快照列表行操作测试
 *
 * 覆盖（REP-006 · 前端 P0 破坏性操作无 UI 覆盖）：
 * 1. FE-SNAP-04 删除记录行操作：行内 [删除] → 确认弹窗 → DELETE /snapshots/{id}
 * 2. FE-SNAP-05 重置撤销手工行操作：行内 [重置] → 确认弹窗 → POST /snapshots/{date}/reset
 * 3. 入口守卫：重置仅对 MANUAL 行可见（DERIVED 行无该按钮）
 *
 * 数据层 mock：snapshot api（listSnapshots/deleteSnapshot/resetToDerived）+ toast；
 * 其余（vue-query hooks / Pinia stores / reka-ui AlertDialog）均走真实实现，
 * 以校验「点击 → mutation → api 调用参数」的完整链路。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SnapshotList from '../components/SnapshotList.vue';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';
import type { PaginatedResponse, SnapshotResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast
// ---------------------------------------------------------------------------

vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
  resetToDerived: vi.fn(),
  upsertSnapshot: vi.fn(),
  updateSnapshot: vi.fn(),
}));

vi.mock('@/api/snapshot.api', () => apiMocks);

// ---------------------------------------------------------------------------
// mock：与行操作无关的展示依赖（范围偏好同步 / 日期控件 / 分页）
// ---------------------------------------------------------------------------

vi.mock('@/modules/analysis/composables/use-range-preference-sync', async () => {
  const { ref } = await import('vue');
  return {
    useRangePreferenceSync: () => ({
      defaultRange: ref(''),
      markInteracted: () => undefined,
    }),
  };
});

vi.mock('@/components/date/DateRangeQuickPicker.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'DateRangeQuickPickerStub',
      setup() {
        return () => h('div', { class: 'drqp-stub' });
      },
    }),
  };
});

vi.mock('@/components/common/Pagination.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'PaginationStub',
      setup() {
        return () => h('div', { class: 'pagination-stub' });
      },
    }),
  };
});

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const PORTFOLIO_ID = 'pf-1';

const derivedRow: SnapshotResponse = {
  id: 'snap-derived',
  portfolioId: PORTFOLIO_ID,
  date: '2024-02-01',
  totalAsset: '1000.00',
  marketValue: '600.00',
  cashBalance: '400.00',
  source: 'DERIVED',
  valuationFlag: 'COST_BASED',
  note: null,
  recordedAt: '2024-02-01T00:00:00.000Z',
  derivedTotalAsset: '1000.00',
  createdAt: '2024-02-01T00:00:00.000Z',
  updatedAt: '2024-02-01T00:00:00.000Z',
};

const manualRow: SnapshotResponse = {
  id: 'snap-manual',
  portfolioId: PORTFOLIO_ID,
  date: '2024-03-01',
  totalAsset: '500.00',
  marketValue: '300.00',
  cashBalance: '200.00',
  source: 'MANUAL',
  valuationFlag: 'MANUAL_INPUT',
  note: '月末估值',
  recordedAt: '2024-03-01T00:00:00.000Z',
  derivedTotalAsset: '498.00',
  createdAt: '2024-03-01T00:00:00.000Z',
  updatedAt: '2024-03-01T00:00:00.000Z',
};

function paged(items: SnapshotResponse[]): PaginatedResponse<SnapshotResponse> {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

let wrapper: VueWrapper | null = null;
let pinia: Pinia;
let queryClient: QueryClient;

/** 完整沉降：微任务 + 少量宏任务，确保 vue-query 与 AlertDialog 渲染落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await nextTick();
}

async function mountList(): Promise<VueWrapper> {
  const w = mount(SnapshotList, {
    props: { portfolioId: PORTFOLIO_ID },
    attachTo: document.body,
    // 注意：不可加 `stubs: { teleport: true }` —— 会把 reka-ui Portal 内的
    // Teleport 替换成 stub，导致弹窗内容不渲染（实测踩坑）。
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return w;
}

/** 取指定数据行的按钮组（列顺序：编辑 / [重置，仅手工行] / 删除） */
function rowButtons(w: VueWrapper, rowIndex: number): DOMWrapper<Element>[] {
  const rows = w.findAll('tbody tr');
  if (!rows[rowIndex]) throw new Error(`未找到第 ${rowIndex} 行`);
  return rows[rowIndex].findAll('button');
}

/**
 * 在 document 范围内按文案找按钮。
 *
 * reka-ui AlertDialog 的内容经自研 Portal 渲染到 body（非原生 <teleport>，
 * `stubs: { teleport: true }` 不生效），故弹窗内的按钮须在 document 上定位。
 */
function buttonByText(text: string): HTMLButtonElement {
  const btns = Array.from(document.querySelectorAll('button'));
  const target = btns.find((b) => (b.textContent ?? '').trim() === text);
  if (!target) throw new Error(`未找到文案为「${text}」的按钮`);
  return target;
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  apiMocks.listSnapshots.mockResolvedValue(paged([derivedRow, manualRow]));
  apiMocks.deleteSnapshot.mockResolvedValue(null);
  apiMocks.resetToDerived.mockResolvedValue(null);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('SnapshotList 行操作（FE-SNAP-04/05）', () => {
  it('重置入口仅对 MANUAL 行可见（DERIVED 行无该按钮）', async () => {
    wrapper = await mountList();

    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    // DERIVED 行：编辑 + 删除 = 2 个按钮
    expect(rowButtons(wrapper, 0)).toHaveLength(2);
    // MANUAL 行：编辑 + 重置 + 删除 = 3 个按钮
    expect(rowButtons(wrapper, 1)).toHaveLength(3);
    expect(
      rowButtons(wrapper, 1).some(
        (b) => b.attributes('title') === '重置为系统自动值',
      ),
    ).toBe(true);
    expect(
      rowButtons(wrapper, 0).some(
        (b) => b.attributes('title') === '重置为系统自动值',
      ),
    ).toBe(false);
  });

  it('FE-SNAP-04 删除记录：确认弹窗走 DELETE /snapshots/{id} 并提示已删除', async () => {
    wrapper = await mountList();

    // 行内 [删除]（MANUAL 行）→ 打开确认弹窗
    const deleteBtn = rowButtons(wrapper, 1).find(
      (b) => b.attributes('title') === '删除',
    )!;
    await deleteBtn.trigger('click');
    await settle();

    expect(document.body.textContent).toContain('确认删除该条资产记录？');

    buttonByText('确认删除').click();
    await settle();

    expect(apiMocks.deleteSnapshot).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteSnapshot).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      manualRow.id,
    );

    const { toast } = await import('@/composables/use-toast');
    expect(toast.success).toHaveBeenCalledWith('快照已删除');
  });

  it('FE-SNAP-05 重置撤销手工：确认弹窗走 POST /snapshots/{date}/reset 并提示已恢复', async () => {
    wrapper = await mountList();

    const resetBtn = rowButtons(wrapper, 1).find(
      (b) => b.attributes('title') === '重置为系统自动值',
    )!;
    await resetBtn.trigger('click');
    await nextTick();

    expect(document.body.textContent).toContain('重置为系统自动计算值？');

    buttonByText('确认重置').click();
    await settle();

    expect(apiMocks.resetToDerived).toHaveBeenCalledTimes(1);
    expect(apiMocks.resetToDerived).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      manualRow.date,
    );

    const { toast } = await import('@/composables/use-toast');
    expect(toast.success).toHaveBeenCalledWith('已恢复系统自动计算值');
  });

  it('破坏性操作不点确认则不调用 API（取消路径零副作用）', async () => {
    wrapper = await mountList();

    const deleteBtn = rowButtons(wrapper, 0).find(
      (b) => b.attributes('title') === '删除',
    )!;
    await deleteBtn.trigger('click');
    await nextTick();
    buttonByText('取消').click();
    await settle();

    expect(apiMocks.deleteSnapshot).not.toHaveBeenCalled();
    expect(apiMocks.resetToDerived).not.toHaveBeenCalled();
  });
});
