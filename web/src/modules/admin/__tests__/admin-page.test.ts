/**
 * modules/admin/__tests__/admin-page.test.ts — 系统管理页 RBAC 与提供方新增验收
 *
 * 平移自 React 版 web/src/pages/__tests__/admin.test.tsx，验收点：
 * 1. 非管理员：页面不渲染「新增数据来源」按钮，改为展示「无权限访问该页面」
 * 2. 管理员：表格可见并列出提供方，且展示「新增数据来源」按钮
 * 3. 管理员：点击「新增数据来源」打开对话框，填写并提交调用 createQuoteProvider，
 *    且请求体含 name / access_method=https / config.base_url / enabled
 * 4. 模块切换 + localStorage 激活模块持久化（刷新后停留同一分页）
 *
 * Mock 策略（同 React）：@/stores/auth.store 的 useIsAdmin 由模块级 adminFlag 控制；
 * api 层（quote-provider / quote-interface / interface-category）全部 mock；
 * InterfaceCategorySection / StockListTestSection 以替身 div 标记渲染（避免拉入重依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

// 模块级开关：控制 useIsAdmin 的返回值（在测试间切换）
let adminFlag = false;

vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => adminFlag,
  useAuthStore: () => ({
    user: adminFlag ? { role: 'admin' } : { role: 'user' },
    token: null,
    isAuthenticated: adminFlag,
    login: () => {},
    logout: () => {},
    setUser: () => {},
  }),
}));

const SAMPLE_LIST = [
  {
    id: 'p1',
    name: '新浪财经',
    access_method: 'https',
    config: { base_url: 'https://finance.sina.com.cn/api' },
    enabled: true,
    description: '默认源',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

vi.mock('@/api/quote-provider.api', () => ({
  listQuoteProviders: vi.fn(() => Promise.resolve(SAMPLE_LIST)),
  createQuoteProvider: vi.fn((body: unknown) =>
    Promise.resolve({ ...SAMPLE_LIST[0], id: 'new', name: '新建源', ...(body as object) }),
  ),
  updateQuoteProvider: vi.fn(() => Promise.resolve(null)),
  deleteQuoteProvider: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/api/quote-interface.api', () => ({
  listProviderInterfaces: vi.fn(() => Promise.resolve([])),
  createInterface: vi.fn(() => Promise.resolve(null)),
  updateInterface: vi.fn(() => Promise.resolve(null)),
  deleteInterface: vi.fn(() => Promise.resolve(null)),
  listAllInterfaces: vi.fn(() => Promise.resolve([])),
  reorderQuoteInterfaces: vi.fn(() => Promise.resolve({ ok: true })),
  testInterface: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/api/interface-category.api', () => ({
  listInterfaceCategories: vi.fn(() => Promise.resolve([])),
  updateInterfaceCategory: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// reka-ui Select 原生替身（接入方式下拉，默认 https 无需操作）
vi.mock('@/components/ui/select', async () => {
  await import('vue');
  const Select = defineComponent({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () =>
        h(
          'select',
          {
            value: props.modelValue ?? '',
            'data-testid': 'select',
            class: 'select-stub',
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          [h('option', { key: '__ph', value: '' }, ''), slots.default?.()],
        );
    },
  });
  const SelectItem = defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      return () => h('option', { value: props.value }, slots.default?.());
    },
  });
  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
  const renderNothing = defineComponent({
    setup() {
      return () => null;
    },
  });
  return {
    Select,
    SelectItem,
    SelectTrigger: renderNothing,
    SelectValue: renderNothing,
    SelectContent: passthrough,
    SelectGroup: passthrough,
    SelectLabel: renderNothing,
  };
});

// 非当前测试目标的两个子模块：替身 div（断言渲染切换用）
vi.mock('../components/InterfaceCategorySection.vue', () => ({
  default: defineComponent({
    name: 'InterfaceCategorySectionStub',
    setup() {
      return () => h('div', { class: 'interface-category-stub' }, '接口分类管理内容');
    },
  }),
}));
vi.mock('../components/StockListTestSection.vue', () => ({
  default: defineComponent({
    name: 'StockListTestSectionStub',
    setup() {
      return () => h('div', { class: 'stock-list-test-stub' }, '股票列表和测试内容');
    },
  }),
}));

import AdminPage from '../pages/AdminPage.vue';
import { createQuoteProvider, listQuoteProviders } from '@/api/quote-provider.api';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

let queryClient: QueryClient;
let pinia: Pinia;

/** jsdom 缺失的浏览器 API 兜底（reka-ui Dialog Portal 需要，同 portfolio-dialog.test） */

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(AdminPage, {
    attachTo: document.body,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

/** 按文本找按钮 */
function findButton(wrapper: VueWrapper, text: string): DOMWrapper<HTMLButtonElement> {
  const btns = wrapper.findAll('button');
  const target = btns.find((b) => b.text().includes(text));
  if (!target) throw new Error(`未找到按钮「${text}」`);
  return target;
}

beforeEach(() => {
  adminFlag = false;
  vi.clearAllMocks();
  localStorage.clear();
  installJsdomPolyfills();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe('AdminPage — 多提供方管理 RBAC 与表单', () => {
  it('① 非管理员：不渲染「新增数据来源」，展示「无权限访问该页面」', async () => {
    adminFlag = false;
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('无权限访问该页面');
    expect(wrapper.text()).not.toContain('新增数据来源');
    // 非管理员不发请求（useQuoteProviders enabled=false）
    expect(listQuoteProviders).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('② 管理员：表格可见并列出提供方，且展示「新增数据来源」按钮', async () => {
    adminFlag = true;
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain('新浪财经');
    expect(wrapper.text()).toContain('HTTPS 提供方');
    expect(findButton(wrapper, '新增数据来源').exists()).toBe(true);
    expect(listQuoteProviders).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it('③ 管理员：新增数据来源填写并提交调用 createQuoteProvider', async () => {
    adminFlag = true;
    const wrapper = await mountPage();
    await nextTick();

    await findButton(wrapper, '新增数据来源').trigger('click');
    await flushPromises();
    await nextTick();

    // 对话框内容经 reka-ui DialogPortal 渲染到 body（attachTo: document.body），
    // wrapper.find 查不到 portal 节点，改用 document 查询。
    const qname = () =>
      document.body.querySelector('#qp-name') as HTMLInputElement | null;
    const qurl = () =>
      document.body.querySelector('#qp-base-url') as HTMLInputElement | null;
    const qsave = () =>
      (Array.from(document.body.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('保存'),
      ) as HTMLButtonElement | null) ?? undefined;

    const nameInput = qname();
    if (!nameInput) throw new Error('未找到 #qp-name 输入框');
    nameInput.value = '新建源';
    nameInput.dispatchEvent(new Event('input'));

    const urlInput = qurl();
    if (!urlInput) throw new Error('未找到 #qp-base-url 输入框');
    urlInput.value = 'https://x.com/api';
    urlInput.dispatchEvent(new Event('input'));
    await nextTick();

    const saveBtn = qsave();
    if (!saveBtn) throw new Error('未找到「保存」按钮');
    saveBtn.click();
    await flushPromises();

    expect(createQuoteProvider).toHaveBeenCalledTimes(1);
    expect(createQuoteProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '新建源',
        access_method: 'https',
        config: { base_url: 'https://x.com/api' },
        enabled: true,
      }),
    );

    wrapper.unmount();
  });

  it('④ 模块切换：点击「接口分类管理」渲染对应模块并持久化激活模块到 localStorage', async () => {
    adminFlag = true;
    const wrapper = await mountPage();

    expect(wrapper.find('.interface-category-stub').exists()).toBe(false);

    // reka-ui TabsTrigger 以 onMousedown 切换激活页签，jsdom 下触发 mousedown 以驱动切换
    await findButton(wrapper, '接口分类管理').trigger('mousedown');
    await nextTick();
    await flushPromises();

    expect(wrapper.find('.interface-category-stub').exists()).toBe(true);
    expect(localStorage.getItem('invest:admin-active-module')).toBe(
      'interface-category',
    );

    wrapper.unmount();
  });
});
