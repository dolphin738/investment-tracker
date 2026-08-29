/**
 * modules/snapshot/__tests__/snapshot-edit-entry.test.ts — 快照编辑入口（FE-SNP-03）
 *
 * 覆盖（REP-007 · 前端 P0 部分覆盖补全 · FE-SNP-03）：
 * 快照列表行「编辑（变手工）」按钮 → 触发 emit('edit', snapshot)，把行数据交由
 * 父页面（SnapshotsPage）以「变手工」方式打开 SnapshotForm。此前该入口仅以
 * 行按钮存在性（2/3 个按钮）被间接覆盖，未验证「点击 → emit 链路」。
 *
 * 数据层 mock：snapshot api + toast；其余（vue-query / Pinia / 真实 AlertDialog）
 * 走真实实现。仅校验 SnapshotList 自身负责的「入口 → emit」链路（表单变手工挂载
 * 属父页面职责）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SnapshotList from '../components/SnapshotList.vue';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';
import type { PaginatedResponse, SnapshotResponse } from '@/api/types';

vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
  resetToDerived: vi.fn(),
  upsertSnapshot: vi.fn(),
  updateSnapshot: vi.fn(),
  getSnapshotByDate: vi.fn(),
}));

vi.mock('@/api/snapshot.api', () => apiMocks);

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
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return w;
}

function rowButtons(w: VueWrapper, rowIndex: number) {
  const rows = w.findAll('tbody tr');
  if (!rows[rowIndex]) throw new Error(`未找到第 ${rowIndex} 行`);
  return rows[rowIndex].findAll('button');
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
  document.body.innerHTML = '';
});

describe('SnapshotList 编辑入口（FE-SNP-03）', () => {
  it('DERIVED 行点击编辑 → emit("edit", 该行快照)', async () => {
    wrapper = await mountList();

    const editBtn = rowButtons(wrapper, 0).find(
      (b) => b.attributes('title') === '编辑（变手工）',
    )!;
    await editBtn.trigger('click');
    await settle();

    const emitted = wrapper.emitted('edit');
    expect(emitted).toBeTruthy();
    expect(emitted!.length).toBe(1);
    expect(emitted![0][0]).toMatchObject({ id: derivedRow.id });
  });

  it('MANUAL 行点击编辑同样 emit("edit")', async () => {
    wrapper = await mountList();

    const editBtn = rowButtons(wrapper, 1).find(
      (b) => b.attributes('title') === '编辑（变手工）',
    )!;
    await editBtn.trigger('click');
    await settle();

    const emitted = wrapper.emitted('edit');
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toMatchObject({ id: manualRow.id });
  });
});
