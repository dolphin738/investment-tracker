/**
 * modules/admin/__tests__/quote-interface-dialog-prefill.test.ts
 *
 * 新增态「一键预填」（实调探测预填字段映射）回归：
 * 1. 新增态 + SDK 提供方 + endpoint 已填 → 按钮解禁，点击调 previewQuoteInterface
 *    （不依赖已存接口），成功后走 prefillRowsFromRaw 管线生成映射行（toast.success）；
 * 2. 新增态 + endpoint 未填 → 按钮禁用（title 给原因）；
 * 3. 新增态 + HTTPS 提供方 → 按钮禁用（title 说明 v1 不支持实调预填）；
 * 4. 编辑态 → 仍走既有试调端点 testInterface，不调 previewQuoteInterface；
 * 5. 新增态探测失败（status=error）→ toast.error 透传后端中文错误消息。
 *
 * API 层与 toast 全部 mock 隔离网络；预填取数 prefillRowsFromInterface 用真实实现，
 * 同时覆盖「编辑态/新增态」双分支路由与错误转译。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { QuoteInterface } from '@/api/quote-interface.api';
import type { QuoteProvider } from '@/api/quote-provider.api';
import { toast } from '@/composables/use-toast';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：接口 API（捕获 test/preview 调用体）+ toast + auth + 分类/提供方 composable
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
  listProviderInterfaces: vi.fn(() => Promise.resolve([])),
  createInterface: vi.fn(() => Promise.resolve({})),
  updateInterface: vi.fn(() => Promise.resolve({})),
  deleteInterface: vi.fn(() => Promise.resolve({ id: '', deleted: true })),
  listAllInterfaces: vi.fn(() => Promise.resolve([])),
  reorderQuoteInterfaces: vi.fn(() => Promise.resolve({ ok: true })),
  fetchResponseFieldSchema: vi.fn(() => Promise.resolve(null)),
  testInterface: vi.fn(),
  previewQuoteInterface: vi.fn(),
}));

vi.mock('@/api/quote-interface.api', () => api);

vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => true,
  useAuthStore: () => ({
    user: { role: 'admin' },
    token: null,
    isAuthenticated: true,
    login: () => {},
    logout: () => {},
    setUser: () => {},
  }),
}));

vi.mock('@/modules/admin/composables/use-interface-category', () => ({
  useInterfaceCategories: () => ({ data: ref([]) }),
}));

const providers = vi.hoisted(() => ({
  data: [
    {
      id: 'p-sdk',
      name: 'AKShare',
      access_method: 'sdk',
      config: { sdk_name: 'akshare' },
      enabled: true,
      description: null,
      created_at: '',
      updated_at: '',
    },
    {
      id: 'p-https',
      name: 'HTTPS 源',
      access_method: 'https',
      config: { base_url: 'https://x.example.com' },
      enabled: true,
      description: null,
      created_at: '',
      updated_at: '',
    },
  ] as QuoteProvider[],
}));

vi.mock('@/modules/admin/composables/use-quote-provider', () => ({
  useQuoteProviders: () => ({ data: ref(providers.data) }),
}));

import QuoteInterfaceDialog from '../components/QuoteInterfaceDialog.vue';

let wrapper: VueWrapper | null = null;

/** body 文本（Portal 传送目的地） */
const bodyText = (): string => document.body.textContent ?? '';

/** 「一键预填」按钮（经 reka-ui Portal 落在 document.body；位于「字段映射」页签内） */
function prefillButton(): HTMLButtonElement {
  const btns = Array.from(
    document.body.querySelectorAll('button'),
  ) as HTMLButtonElement[];
  const b = btns.find((x) => x.textContent?.includes('一键预填'));
  if (!b) throw new Error('未找到「一键预填」按钮');
  return b;
}

/** 切到「字段映射」页签（Tabs 非激活页签默认卸载；reka-ui 触发器监听 mousedown 激活） */
async function openMappingTab(): Promise<void> {
  const tabs = Array.from(
    document.body.querySelectorAll('[role="tab"]'),
  ) as HTMLButtonElement[];
  const t = tabs.find((x) => x.textContent?.includes('字段映射'));
  if (!t) throw new Error('未找到「字段映射」页签');
  t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  t.click();
  await flushPromises();
  await nextTick();
}

async function mountDialog(opts: {
  providerId: string;
  editing?: QuoteInterface | null;
}): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(QuoteInterfaceDialog, {
    props: {
      open: false,
      providerId: opts.providerId,
      editing: opts.editing ?? null,
    },
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], pinia],
    },
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  await nextTick();
}

/** 原生设置输入值（v-model 经 input 事件同步） */
async function setInput(selector: string, value: string): Promise<void> {
  const el = document.body.querySelector(selector) as HTMLInputElement | null;
  if (!el) throw new Error(`未找到输入框 ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
  await nextTick();
}

/** 沉降异步 handler（flushPromises + 微任务多轮） */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

/** 编辑态最小 QuoteInterface 夹具（字段契约对齐 QuoteInterface 类型） */
function editingFixture(): QuoteInterface {
  return {
    id: 'itf-1',
    provider_id: 'p-sdk',
    category_id: null,
    name: '已有接口',
    endpoint: 'stock_zh_a_spot',
    http_method: null,
    params: {},
    enabled: true,
    description: null,
    direction: 'in',
    timeout: null,
    retry_count: null,
    rate_limit: null,
    asset_class: [],
    resp_code_field: 'code',
    resp_price_field: 'price',
    resp_name_field: null,
    resp_exchange_field: null,
    response_fields: null,
    response_parse: null,
    priority: null,
    created_at: '',
    updated_at: '',
  };
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('QuoteInterfaceDialog — 新增态一键预填（实调探测）', () => {
  it('① 新增态 + SDK + endpoint 已填：按钮解禁，点击调 previewQuoteInterface 并预填成功', async () => {
    api.previewQuoteInterface.mockResolvedValue({
      ok: true,
      status: 'success',
      elapsedMs: 12,
      raw: [{ code: '600000', price: '12.34' }],
      rowCount: 1,
      warnings: [],
    });
    await mountDialog({ providerId: 'p-sdk' });
    // endpoint 输入框位于「基本信息」页签，先填再切页签（Tabs 非激活页签卸载）
    await setInput('#qi-endpoint', 'stock_zh_a_spot');
    await openMappingTab();

    expect(prefillButton().disabled).toBe(false);
    prefillButton().click();
    await settle();

    expect(api.previewQuoteInterface).toHaveBeenCalledTimes(1);
    const body = api.previewQuoteInterface.mock.calls[0][0] as {
      endpoint: string;
      provider_id: string;
      params: Record<string, unknown>;
    };
    expect(body.endpoint).toBe('stock_zh_a_spot');
    expect(body.provider_id).toBe('p-sdk');
    // 参数编辑器为空行 → params 为空对象（后端按 akshare 签名默认值调用）
    expect(body.params).toEqual({});
    // 编辑态试调端点未被误用
    expect(api.testInterface).not.toHaveBeenCalled();
    // 成功提示（复用 prefillRowsFromRaw 管线，raw 首行 2 列 → 2 个映射行）
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('预填 2 个字段'),
    );
  });

  it('② 新增态 + endpoint 未填：按钮禁用，title 说明需先填调用路径', async () => {
    await mountDialog({ providerId: 'p-sdk' });
    await openMappingTab();
    const btn = prefillButton();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toContain('调用路径');
    btn.click();
    await settle();
    expect(api.previewQuoteInterface).not.toHaveBeenCalled();
  });

  it('③ 新增态 + HTTPS 提供方：按钮禁用，title 说明 v1 不支持实调预填', async () => {
    await mountDialog({ providerId: 'p-https' });
    await setInput('#qi-endpoint', '/api/ashare/list');
    await openMappingTab();

    const btn = prefillButton();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toContain('HTTPS');
  });

  it('④ 编辑态：点击仍走试调端点 testInterface，不调 previewQuoteInterface', async () => {
    api.testInterface.mockResolvedValue({
      ok: true,
      status: 'success',
      elapsedMs: 8,
      raw: [{ code: '600000', price: '12.34' }],
    });
    await mountDialog({ providerId: 'p-sdk', editing: editingFixture() });
    await openMappingTab();

    expect(prefillButton().disabled).toBe(false);
    prefillButton().click();
    await settle();

    expect(api.testInterface).toHaveBeenCalledTimes(1);
    expect(api.testInterface.mock.calls[0][0]).toBe('itf-1');
    expect(api.testInterface.mock.calls[0][1]).toEqual({ params: {} });
    expect(api.previewQuoteInterface).not.toHaveBeenCalled();
  });

  it('⑤ 新增态探测失败：toast.error 透传后端中文错误消息', async () => {
    api.previewQuoteInterface.mockResolvedValue({
      ok: false,
      status: 'error',
      elapsedMs: 3,
      raw: null,
      warnings: [],
      error: 'akshare 中不存在函数 no_such_func',
    });
    await mountDialog({ providerId: 'p-sdk' });
    await setInput('#qi-endpoint', 'no_such_func');
    await openMappingTab();

    prefillButton().click();
    await settle();

    expect(api.previewQuoteInterface).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('akshare 中不存在函数 no_such_func'),
    );
  });
});
