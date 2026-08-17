/**
 * modules/data-transfer/__tests__/data-transfer.test.ts — 数据导入导出测试
 *
 * 覆盖（B13）：
 * 1. 导出校验：全不选 → 提示「请先选择要导出的数据类型」
 * 2. 导出成功：选中类型 + 默认 CSV → 串行触发下载，文件名为 `{组合}-{类型}-{YYYYMMDD}.{ext}`
 * 3. 导入校验：未选文件点预览 → 提示「请先选择要导入的文件」
 * 4. 导入提交：无有效预览时「确认导入」按钮禁用
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import ExportPanel from '../components/ExportPanel.vue';
import ImportDialog from '../components/ImportDialog.vue';

// ---------------------------------------------------------------------------
// mock：数据层 api + toast + 下载触发
// ---------------------------------------------------------------------------

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('vue-sonner', () => ({ toast: toastMocks }));

const apiMocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  downloadTemplate: vi.fn(),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
}));

vi.mock('@/api/data-transfer.api', () => apiMocks);

const csvMocks = vi.hoisted(() => ({ downloadBlob: vi.fn() }));

vi.mock('@/lib/csv-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv-download')>()),
  downloadBlob: csvMocks.downloadBlob,
}));

/** jsdom 缺失的浏览器 API 兜底（reka-ui Dialog / Select 需要） */
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
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      function releasePointerCapture(): void {};
  }
}

let wrapper: VueWrapper | null = null;

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function mountWithExportPanel(props: Record<string, unknown>) {
  return mount(ExportPanel, {
    props: props as { portfolioId: string; portfolioName: string },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: makeQueryClient() }], createPinia()],
    },
  });
}

/** 返回 todayInAppTzIso 同口径的 YYYYMMDD（UTC+8 位移后取日历日） */
function todayCompactIso(): string {
  const appNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return appNow.toISOString().slice(0, 10);
}

beforeEach(() => {
  installJsdomPolyfills();
  Object.values(toastMocks).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
  apiMocks.exportData.mockReset();
  apiMocks.previewImport.mockReset();
  apiMocks.commitImport.mockReset();
  csvMocks.downloadBlob.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------
// 导出面板（无对话框，最稳定）
// ---------------------------------------------------------------------------

describe('ExportPanel — 导出面板', () => {
  it('全不选类型时点导出：提示「请先选择要导出的数据类型」，不发起下载', async () => {
    wrapper = mountWithExportPanel({
      portfolioId: 'pf-1',
      portfolioName: '我的组合',
    }) as VueWrapper;

    const exportBtn = wrapper.findAll('button').find((b) => b.text().includes('导出'));
    expect(exportBtn).toBeTruthy();
    await exportBtn!.trigger('click');

    expect(toastMocks.info).toHaveBeenCalledWith('请先选择要导出的数据类型');
    expect(apiMocks.exportData).not.toHaveBeenCalled();
  });

  it('选中 1 类 + 默认 CSV：导出成功后串行触发下载，文件名为 {组合}-{类型}-{YYYYMMDD}.{ext}', async () => {
    vi.useFakeTimers();
    apiMocks.exportData.mockResolvedValue(new Blob(['data']));

    wrapper = mountWithExportPanel({
      portfolioId: 'pf-1',
      portfolioName: '我的组合',
    }) as VueWrapper;

    const firstCheckbox = wrapper.findAll('input[type=checkbox]').at(0);
    expect(firstCheckbox).toBeTruthy();
    await firstCheckbox!.setValue(true);
    const exportBtn2 = wrapper.findAll('button').find((b) => b.text().includes('导出'));
    await exportBtn2!.trigger('click');
    await vi.advanceTimersByTimeAsync(500);

    expect(apiMocks.exportData).toHaveBeenCalledTimes(1);
    const [portfolioId, params] = apiMocks.exportData.mock.calls[0];
    expect(portfolioId).toBe('pf-1');
    expect(params.format).toBe('csv');
    // 文件名（类型来自 EXPORT_TYPE_OPTIONS 第一项 securities）
    expect(csvMocks.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = csvMocks.downloadBlob.mock
      .calls[0] as unknown as [Blob, string];
    expect(blob).toBeInstanceOf(Blob);
    expect(filename.toLowerCase()).toContain('-securities-');
    expect(filename.toLowerCase()).toContain(todayCompactIso());
    expect(filename.endsWith('.csv')).toBe(true);
    expect(toastMocks.success).toHaveBeenCalledWith('已导出 1 个文件');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 导入对话框（stub 掉 reka-ui Dialog，避免 teleport + 可见性轮询在 jsdom 下不稳定）
// ---------------------------------------------------------------------------

const dialogStubs = {
  Dialog: { template: '<div class="dt-dialog"><slot /></div>' },
  DialogContent: { template: '<div class="dt-content"><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<div><slot /></div>' },
  DialogDescription: { template: '<div><slot /></div>' },
  DialogFooter: { template: '<div><slot /></div>' },
};

function mountImportDialog() {
  return mount(ImportDialog, {
    props: { portfolioId: 'pf-1', open: true },
    global: {
      stubs: dialogStubs,
      plugins: [
        [VueQueryPlugin, { queryClient: makeQueryClient() }],
        createPinia(),
      ],
    },
  });
}

describe('ImportDialog — 导入对话框', () => {
  it('未选择文件点预览：提示「请先选择要导入的文件」，不发预览请求', async () => {
    wrapper = mountImportDialog();

    const previewBtn = wrapper.findAll('button').find((b) => b.text().includes('预览'));
    expect(previewBtn).toBeTruthy();
    await previewBtn!.trigger('click');

    expect(toastMocks.info).toHaveBeenCalledWith('请先选择要导入的文件');
    expect(apiMocks.previewImport).not.toHaveBeenCalled();
  });

  it('无有效预览时「确认导入」按钮禁用', () => {
    wrapper = mountImportDialog();

    const commitBtn = wrapper.findAll('button').find((b) => b.text().includes('确认导入'));
    expect(commitBtn).toBeTruthy();
    expect((commitBtn!.element as HTMLButtonElement).disabled).toBe(true);
  });
});