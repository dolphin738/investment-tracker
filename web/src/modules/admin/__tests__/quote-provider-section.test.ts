/**
 * modules/admin/__tests__/quote-provider-section.test.ts — 管理面「按分类汇总」dnd 调序验收
 *
 * 平移自 React 版 web/src/features/admin/__tests__/quote-provider-section.test.tsx，
 * 验收点（对应 ADR-002 优先级链 / T09）：
 * 1. 总览渲染：已分类分组带拖拽手柄（aria-label=「拖拽排序 X」），未分类分组不带
 * 2. 初始渲染不触发 reorderQuoteInterfaces（无拖拽则不写后端）
 * 3. useReorderInterfaces（T08）真实 hook 调用 reorderQuoteInterfaces 并带入正确 body
 *
 * 拖拽重排算法 computeReorderedIds 已由 __tests__/reorder.test.ts 独立覆盖（7 例，
 * 比 React 4 例更全），本文件只做 UI 渲染与调序链路。
 *
 * Mock 策略（同 React）：仅 mock api 层（provider / interface / category）+ auth +
 * toast；保留真实 composables 与组件渲染。VueDraggable（vue-draggable-plus）在
 * jsdom 下以透传 stub 替换（保留 v-for 内容与拖拽手柄），避免 sortablejs DOM API 依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

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

const MOCK_PROVIDERS = [
  {
    id: 'p1',
    name: '新浪',
    access_method: 'https',
    config: {},
    enabled: true,
    description: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'p2',
    name: '腾讯',
    access_method: 'https',
    config: {},
    enabled: true,
    description: null,
    created_at: '',
    updated_at: '',
  },
];

function mkIface(
  id: string,
  provider_id: string,
  category_id: string | null,
  name: string,
  priority: number | null,
) {
  return {
    id,
    provider_id,
    category_id,
    name,
    endpoint: `/${id}`,
    http_method: 'GET',
    params: null,
    enabled: true,
    description: null,
    direction: 'in',
    timeout: null,
    retry_count: null,
    rate_limit: null,
    asset_class: null,
    resp_code_field: 'code',
    resp_price_field: 'price',
    resp_name_field: null,
    resp_exchange_field: null,
    response_parse: null,
    priority,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const SAMPLE_INTERFACES = [
  mkIface('i1', 'p1', 'c1', '接口A', 0),
  mkIface('i2', 'p1', 'c1', '接口B', 1),
  mkIface('i3', 'p2', 'c1', '接口C', 2),
  mkIface('i4', 'p2', null, '接口D', null),
];

vi.mock('@/api/quote-provider.api', () => ({
  listQuoteProviders: vi.fn(() => Promise.resolve(MOCK_PROVIDERS)),
  createQuoteProvider: vi.fn(() => Promise.resolve(null)),
  updateQuoteProvider: vi.fn(() => Promise.resolve(null)),
  deleteQuoteProvider: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/api/quote-interface.api', () => ({
  listProviderInterfaces: vi.fn(() => Promise.resolve([])),
  createInterface: vi.fn(() => Promise.resolve(null)),
  updateInterface: vi.fn(() => Promise.resolve(null)),
  deleteInterface: vi.fn(() => Promise.resolve(null)),
  listAllInterfaces: vi.fn(() => Promise.resolve(SAMPLE_INTERFACES)),
  reorderQuoteInterfaces: vi.fn(() => Promise.resolve({ ok: true })),
  testInterface: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/api/interface-category.api', () => ({
  listInterfaceCategories: vi.fn(() =>
    Promise.resolve([
      {
        id: 'c1',
        label: '行情分类',
        icon: null,
        sort_order: 0,
        created_at: '',
        updated_at: '',
      },
    ]),
  ),
  updateInterfaceCategory: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// reka-ui Select 原生替身（QuoteProviderDialog 接入方式下拉）
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

import QuoteProviderSection from '../components/QuoteProviderSection.vue';
import { useReorderInterfaces } from '../composables/use-quote-interface';
import { reorderQuoteInterfaces } from '@/api/quote-interface.api';

let queryClient: QueryClient;
let pinia: Pinia;

async function mountSection(): Promise<VueWrapper> {
  const wrapper = mount(QuoteProviderSection, {
    attachTo: document.body,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
      stubs: {
        teleport: true,
        // vue-draggable-plus 在 jsdom 无完整 DOM API，透传 slot（保留 v-for 行与拖拽手柄）
        VueDraggable: {
          template: '<tbody><slot /></tbody>',
        },
      },
    },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe('QuoteProviderSection — 按分类汇总 dnd 调序 UI', () => {
  it('① 已分类分组渲染拖拽手柄，未分类分组不带手柄', async () => {
    const wrapper = await mountSection();

    // 分类 c1 下三个接口均带拖拽手柄
    expect(wrapper.find('[aria-label="拖拽排序 接口A"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="拖拽排序 接口B"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="拖拽排序 接口C"]').exists()).toBe(true);
    // 未分类（接口D）不带手柄
    expect(wrapper.find('[aria-label="拖拽排序 接口D"]').exists()).toBe(false);

    // 接口名称均可见
    expect(wrapper.text()).toContain('接口A');
    expect(wrapper.text()).toContain('接口D');
    // 分类标签展示
    expect(wrapper.text()).toContain('行情分类');

    wrapper.unmount();
  });

  it('② 初始渲染不触发 reorderQuoteInterfaces', async () => {
    const wrapper = await mountSection();

    expect(wrapper.find('[aria-label="拖拽排序 接口A"]').exists()).toBe(true);
    expect(reorderQuoteInterfaces).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});

describe('useReorderInterfaces — T08 调序 hook 链路', () => {
  it('① 调用 mutateAsync 即触发 reorderQuoteInterfaces 且 body 正确', async () => {
    const Host = defineComponent({
      name: 'ReorderHost',
      setup() {
        const mutation = useReorderInterfaces();
        return { run: (body: unknown) => mutation.mutateAsync(body as never) };
      },
      template: '<div />',
    });

    const wrapper = mount(Host, {
      global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
    });

    await (
      wrapper.vm as { run: (b: unknown) => Promise<unknown> }
    ).run({
      category_id: 'c1',
      ordered_ids: ['i2', 'i1', 'i3'],
    });
    await flushPromises();

    expect(reorderQuoteInterfaces).toHaveBeenCalledWith({
      category_id: 'c1',
      ordered_ids: ['i2', 'i1', 'i3'],
    });

    wrapper.unmount();
  });
});
