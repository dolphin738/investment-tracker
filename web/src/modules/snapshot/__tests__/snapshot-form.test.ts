/**
 * modules/snapshot/__tests__/snapshot-form.test.ts — 资产快照表单测试
 *
 * 覆盖（B8 批次验收：默认渲染 / schema 校验 / 覆盖提示 / 提交语义）：
 * 1. 渲染默认值：日期默认今天、总资产占位 0.00、可选字段占位「可选」、按钮「保存并重算」
 * 2. schema 校验：总资产为空 / 非正数、备注超 200 字（错误消息逐条锁定，不触发提交）
 * 3. 覆盖提示：该日已有自动记录（derivedTotalAsset 非空）→ amber 提示卡展示系统自动值
 * 4. 提交语义（新建/DERIVED）：走 upsertSnapshot（POST，保存即变手工）+ success 事件
 * 5. 提交语义（编辑 MANUAL）：值回填 + 走 updateSnapshot（PATCH）
 *
 * 数据层 mock：snapshot api + toast（避免真实网络与 sonner 渲染副作用）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SnapshotForm from '../components/SnapshotForm.vue';
import { toIsoDate } from '@/lib/constants';
import type { PaginatedResponse, SnapshotResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast
// ---------------------------------------------------------------------------

vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const apiMocks = vi.hoisted(() => ({
  upsertSnapshot: vi.fn(),
  updateSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  resetToDerived: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock('@/api/snapshot.api', () => apiMocks);

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** jsdom 缺失的浏览器 API 兜底（reka-ui 组件挂载需要） */
function installJsdomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
}

const today = toIsoDate(new Date());

/** 分页响应夹具（useNavTotalAssetMap 按 pageSize=1 精确查单日） */
function paged(items: SnapshotResponse[]): PaginatedResponse<SnapshotResponse> {
  return { items, total: items.length, page: 1, pageSize: 1 };
}

/** 编辑态夹具（MANUAL 行 → PATCH 更新） */
const manualSnapshot: SnapshotResponse = {
  id: 'snap-1',
  portfolioId: 'pf-1',
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

let wrapper: VueWrapper | null = null;

function mountForm(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(SnapshotForm, {
    props: { portfolioId: 'pf-1', ...props },
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], createPinia()],
    },
  });
  return wrapper;
}

/**
 * 完整沉降：flushPromises + 少量 macrotask 轮次，确保 vee-validate 的异步
 * 校验（偶发内部 debounce/nextTick）与 mutation 提交在断言前全部落定。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

/** 触发提交并等待 vee-validate 异步校验与微/宏任务队列完全落定 */
async function submitForm(): Promise<void> {
  await wrapper!.find('form').trigger('submit');
  await settle();
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.upsertSnapshot.mockReset();
  apiMocks.updateSnapshot.mockReset();
  // 默认：该日无记录（无覆盖提示）
  apiMocks.listSnapshots.mockReset();
  apiMocks.listSnapshots.mockResolvedValue(paged([]));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('SnapshotForm — 资产快照录入/编辑表单', () => {
  it('渲染默认值：日期默认今天、总资产占位 0.00、可选字段占位「可选」、按钮「保存并重算」', async () => {
    mountForm();
    await flushPromises();

    expect(
      (wrapper!.find('input#snapshot-date').element as HTMLInputElement).value,
    ).toBe(today);
    expect(
      (wrapper!.find('input#snapshot-asset').element as HTMLInputElement)
        .placeholder,
    ).toBe('0.00');
    expect(
      (wrapper!.find('input#snapshot-market').element as HTMLInputElement)
        .placeholder,
    ).toBe('可选');
    expect(
      (wrapper!.find('input#snapshot-cash').element as HTMLInputElement)
        .placeholder,
    ).toBe('可选');
    expect(wrapper!.find('button[type="submit"]').text()).toBe('保存并重算');
  });

  it('schema 校验：总资产为空 / 非正数、备注超 200 字时显示错误消息且不触发提交', async () => {
    mountForm();
    await flushPromises();

    // 总资产为空
    await submitForm();
    expect(wrapper!.text()).toContain('请输入资产总额');

    // 总资产为 0（不大于 0）
    await wrapper!.find('input#snapshot-asset').setValue('0');
    await submitForm();
    expect(wrapper!.text()).toContain('金额必须大于 0');

    // 备注超 200 字
    await wrapper!.find('input#snapshot-asset').setValue('1000');
    await wrapper!.find('textarea#snapshot-note').setValue('a'.repeat(201));
    await submitForm();
    expect(wrapper!.text()).toContain('备注最多 200 字');

    expect(apiMocks.upsertSnapshot).not.toHaveBeenCalled();
    expect(apiMocks.updateSnapshot).not.toHaveBeenCalled();
  });

  it('覆盖提示：该日已有自动记录时展示 amber 提示卡与系统自动计算值', async () => {
    apiMocks.listSnapshots.mockResolvedValue(
      paged([
        {
          ...manualSnapshot,
          source: 'DERIVED',
          totalAsset: '123.45',
          derivedTotalAsset: '123.45',
          date: today,
        },
      ]),
    );
    mountForm();
    await flushPromises();

    expect(wrapper!.text()).toContain('该日已有自动记录，将被覆盖');
    expect(wrapper!.text()).toContain('该日系统自动计算值为 ¥123.45');
    expect(wrapper!.text()).toContain('保存后，您填写的值将取代该日的自动记录');
  });

  it('无覆盖提示：该日无记录时不展示系统自动值提示卡', async () => {
    mountForm();
    await flushPromises();

    expect(wrapper!.text()).not.toContain('该日已有自动记录，将被覆盖');
    expect(wrapper!.text()).not.toContain('该日系统自动计算值为');
  });

  it('提交语义（新建）：走 upsertSnapshot，空可选字段置 undefined，并发出 success', async () => {
    apiMocks.upsertSnapshot.mockResolvedValue({
      ...manualSnapshot,
      date: today,
      totalAsset: '1000.00',
    });
    mountForm();
    await flushPromises();

    await wrapper!.find('input#snapshot-asset').setValue('1000');
    await submitForm();

    expect(apiMocks.upsertSnapshot).toHaveBeenCalledWith('pf-1', {
      date: today,
      totalAsset: '1000',
      marketValue: undefined,
      cashBalance: undefined,
      note: undefined,
    });
    expect(apiMocks.updateSnapshot).not.toHaveBeenCalled();
    expect(wrapper!.emitted('success')).toHaveLength(1);
  });

  it('提交语义（编辑 MANUAL）：值回填、走 updateSnapshot（PATCH）且不触发 upsert', async () => {
    apiMocks.updateSnapshot.mockResolvedValue(manualSnapshot);
    mountForm({ snapshot: manualSnapshot });
    await flushPromises();

    // 回填
    expect(
      (wrapper!.find('input#snapshot-date').element as HTMLInputElement).value,
    ).toBe('2024-03-01');
    expect(
      (wrapper!.find('input#snapshot-asset').element as HTMLInputElement).value,
    ).toBe('500.00');
    expect(
      (wrapper!.find('textarea#snapshot-note').element as HTMLTextAreaElement)
        .value,
    ).toBe('月末估值');

    // 修改总资产后提交
    await wrapper!.find('input#snapshot-asset').setValue('600');
    await submitForm();

    expect(apiMocks.updateSnapshot).toHaveBeenCalledWith('pf-1', 'snap-1', {
      date: '2024-03-01',
      totalAsset: '600',
      marketValue: '300.00',
      cashBalance: '200.00',
      note: '月末估值',
    });
    expect(apiMocks.upsertSnapshot).not.toHaveBeenCalled();
    expect(wrapper!.emitted('success')).toHaveLength(1);
  });
});
