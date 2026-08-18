/**
 * modules/settings/__tests__/settings-page.test.ts — 设置页渲染与偏好保存同步测试
 *
 * 覆盖（B16 批次验收）：
 * 1. 服务端偏好加载后回显到表单，并同步写入 preference.store（刷新保持）
 * 2. 修改偏好后点击「保存偏好」调用 updatePreferences，成功后切默认组合并把增量合并进 store
 * 3. 无偏好变更时「保存偏好」按钮禁用（已是最新）
 *
 * 数据层：真实 composables（usePreferences / useUpdatePreferences / usePortfolios），
 * 仅 mock api 层与无关组件（对话框 / 数据管理 / reka-ui Select / vue-router）。
 * Pinia（portfolio / preference）与 vue-query 均为真实，以校验「保存后刷新保持」链路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { UserPreference } from '@/api/types';
import SettingsPage from '../pages/SettingsPage.vue';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { useUpdatePreferences } from '@/modules/overview/composables/use-preferences';

const SERVER_PREFS: UserPreference = {
  id: 'pref-1',
  userId: 'u-1',
  defaultPortfolioId: null,
  defaultGranularity: 'month',
  defaultDateRange: '1y',
  aggregation: 'last',
  weekStartsOn: 1,
  navDecimals: 4,
  xirrDecimals: 2,
  theme: 'system',
  staleDays: 3,
  showLiquidated: false,
  cashHintOnCashflow: true,
  cashHintOnTrade: true,
  amountThousands: true,
  amountAbbrev: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// 有状态的「后端」偏好：保存后会更新，供 getPreferences 刷新读取（模拟真实服务端落库）
const prefBackend = vi.hoisted(() => ({
  saved: {
    id: 'pref-1',
    userId: 'u-1',
    defaultPortfolioId: null as string | null,
    defaultGranularity: 'month',
    defaultDateRange: '1y',
    aggregation: 'last',
    weekStartsOn: 1,
    navDecimals: 4,
    xirrDecimals: 2,
    theme: 'system',
    staleDays: 3,
    showLiquidated: false,
    cashHintOnCashflow: true as boolean,
    cashHintOnTrade: true,
    amountThousands: true,
    amountAbbrev: false,
  },
}));

const paginationlessPortfolios = vi.hoisted(() => [
  {
    id: 'pf-X',
    name: '组合X',
    archivedAt: null as string | null,
    baseDate: '2025-01-01',
  },
]);

// ---------------------------------------------------------------------------
// vi.mock：api 层（真实 composable 消费）
// ---------------------------------------------------------------------------

vi.mock('@/api/preference.api', () => ({
  getPreferences: vi.fn(() => Promise.resolve({ ...prefBackend.saved })),
  updatePreferences: vi.fn((payload: Partial<UserPreference>) => {
    Object.assign(prefBackend.saved, payload);
    return Promise.resolve({ ...prefBackend.saved });
  }),
}));

vi.mock('@/api/portfolio.api', () => ({
  listPortfolios: vi.fn(() => Promise.resolve(paginationlessPortfolios)),
  clearPortfolioData: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/api/auth.api', () => ({
  deleteAccount: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// vi.mock：vue-router（导出无关，仅哨兵）
// ---------------------------------------------------------------------------

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

// ---------------------------------------------------------------------------
// vi.mock：reka-ui Select 原生替身（页面测试不与其类库交互，仅 jsdom 挂载稳健）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// vi.mock：无关对话框 / 数据管理组件（替身，避免拉入各自真实依赖）
// ---------------------------------------------------------------------------

vi.mock('@/modules/account/components/ChangeEmailDialog.vue', () => ({
  default: defineComponent({
    name: 'ChangeEmailDialogStub',
    props: { open: Boolean },
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/account/components/ChangePasswordDialog.vue', () => ({
  default: defineComponent({
    name: 'ChangePasswordDialogStub',
    props: { open: Boolean },
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/account/components/EditProfileDialog.vue', () => ({
  default: defineComponent({
    name: 'EditProfileDialogStub',
    props: { open: Boolean },
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/data-transfer/components/ExportPanel.vue', () => ({
  default: defineComponent({
    name: 'ExportPanelStub',
    setup() {
      return () => h('div', { class: 'export-stub' });
    },
  }),
}));
vi.mock('@/modules/data-transfer/components/ImportDialog.vue', () => ({
  default: defineComponent({
    name: 'ImportDialogStub',
    setup() {
      return () => null;
    },
  }),
}));
vi.mock('@/modules/data-transfer/components/ImportTemplateButtons.vue', () => ({
  default: defineComponent({
    name: 'ImportTemplateButtonsStub',
    setup() {
      return () => null;
    },
  }),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let queryClient: QueryClient;
let pinia: Pinia;

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(SettingsPage, {
    attachTo: document.body,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
      stubs: {
        teleport: true,
      },
    },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

/** 找到「保存偏好」按钮 */
function saveButton(wrapper: VueWrapper): DOMWrapper<HTMLButtonElement> {
  const btns = wrapper.findAll('button');
  const target = btns.find((b) => b.text().includes('保存偏好'));
  if (!target) throw new Error('未找到「保存偏好」按钮');
  return target;
}

/** 找到首个原生 select（默认组合：'__none__' + 组合选项），并选中给定值触发 change */
function pickFirstSelect(wrapper: VueWrapper, value: string): void {
  const select = wrapper.find('select.select-stub');
  if (!select) throw new Error('未找到默认组合 select');
  (select.element as HTMLSelectElement).value = value;
  select.trigger('change');
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

describe('SettingsPage 偏好保存与同步', () => {
  it('服务端偏好加载后回显并写入 preference.store（刷新保持）', async () => {
    const wrapper = await mountPage();

    const preferenceStore = usePreferenceStore();
    // 偏好已同步进本地 store
    expect(preferenceStore.preferences?.defaultDateRange).toBe('1y');
    expect(preferenceStore.getPreference('aggregation')).toBe('last');
    // 无变更：展示「已是最新」，保存按钮禁用
    expect(wrapper.text()).toContain('已是最新');
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

    wrapper.unmount();
  });

  it('修改偏好后保存：调用 updatePreferences、成功合并进 store 并切默认组合', async () => {
    const wrapper = await mountPage();
    const preferenceStore = usePreferenceStore();
    const portfolioStore = usePortfolioStore();

    // 把默认组合切到「组合X」→ 触发变更
    pickFirstSelect(wrapper, 'pf-X');
    await nextTick();
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    // 调用 updatePreferences 且 payload.defaultPortfolioId 为 string 'pf-X'
    const { updatePreferences } = await import('@/api/preference.api');
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    const payload = (updatePreferences as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.defaultPortfolioId).toBe('pf-X');

    // 成功后：切换当前视图组合 + 增量合并进 preference store（刷新保持）
    expect(portfolioStore.currentPortfolioId).toBe('pf-X');
    expect(preferenceStore.preferences?.defaultPortfolioId).toBe('pf-X');

    wrapper.unmount();
  });

  it('保存偏好成功后偏好 store 保持服务端返回值（乐观更新合并链路）', async () => {
    const wrapper = await mountPage();
    const preferenceStore = usePreferenceStore();

    // 翻转软提示开关（cashHintOnCashflow 默认 true → false）制造变更
    const cashCheckbox = wrapper.find('#pref-hint-cashflow');
    (cashCheckbox.element as HTMLInputElement).checked = false;
    await cashCheckbox.trigger('change');
    await nextTick();

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    const { updatePreferences } = await import('@/api/preference.api');
    const payload = (updatePreferences as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.cashHintOnCashflow).toBe(false);

    // 真实 useUpdatePreferences 在 onSuccess 把增量 payload 合并进本地 store → 刷新保持
    expect(preferenceStore.preferences?.cashHintOnCashflow).toBe(false);
    // 未被本次 payload 覆盖的字段保持服务端原值
    expect(preferenceStore.preferences?.defaultDateRange).toBe('1y');

    wrapper.unmount();
  });
});

describe('useUpdatePreferences 同步 hook', () => {
  it('乐观更新成功把增量 payload 合并进 preference.store（刷新保持）', async () => {
    // 宿主组件在 setup 内调用 hook（vue-query 依赖注入上下文），暴露保存方法供触发
    const Host = defineComponent({
      name: 'PrefHost',
      setup() {
        const mutation = useUpdatePreferences();
        return {
          save: (p: Partial<UserPreference>) => mutation.mutateAsync({ ...p }),
        };
      },
    });

    const preferenceStore = usePreferenceStore();
    preferenceStore.setPreferences({ ...SERVER_PREFS });

    const wrapper = mount(Host, {
      global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
    });

    await (
      wrapper.vm as { save: (p: Partial<UserPreference>) => Promise<unknown> }
    ).save({ defaultDateRange: '3m', aggregation: 'avg' });
    await flushPromises();

    expect(preferenceStore.preferences?.defaultDateRange).toBe('3m');
    expect(preferenceStore.preferences?.aggregation).toBe('avg');
    // 未被覆盖字段保持原值
    expect(preferenceStore.preferences?.staleDays).toBe(3);

    const { toast } = await import('@/composables/use-toast');
    expect(toast.success).toHaveBeenCalledWith('偏好已保存');

    wrapper.unmount();
  }, 10000);
});