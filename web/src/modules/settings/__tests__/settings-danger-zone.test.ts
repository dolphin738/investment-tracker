/**
 * modules/settings/__tests__/settings-danger-zone.test.ts — 设置页危险操作区测试
 *
 * 覆盖（REP-006 · 前端 P0 破坏性操作无 UI 覆盖）：
 * 1. FE-SET-11 清空当前组合数据（SET-P0-05）：组合名称不匹配 → 「确认清空」禁用且不调 API；
 *    精确匹配后才调 clearPortfolioData(portfolioId)
 * 2. FE-SET-12 注销账户（SET-P1-06）：邮箱不匹配 → 「确认注销」禁用；精确匹配后才调 deleteAccount()
 * 3. 守卫边界：输入首尾空格按 trim 后比较（与模板 `x.trim() !== y` 一致）
 *
 * 数据层：真实 composables（useClearPortfolioData / useDeleteAccount）+ 真实 Pinia / vue-query，
 * 仅 mock api 层与无关组件（对话框 / 数据管理 / reka-ui Select / vue-router）。
 * reka-ui AlertDialog 经自研 Portal 渲染到 body，故弹窗内元素一律在 document 上定位
 * （挂载时不可加 `stubs: { teleport: true }`，否则弹窗内容不渲染）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SettingsPage from '../pages/SettingsPage.vue';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// 夹具（hoisted：供 vi.mock 工厂使用）
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  portfolios: [
    {
      id: 'pf-X',
      userId: 'u-1',
      name: '组合X',
      description: null as string | null,
      baseDate: '2025-01-01',
      currency: 'CNY',
      archivedAt: null as string | null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
  ],
  prefs: {
    id: 'pref-1',
    userId: 'u-1',
    defaultPortfolioId: 'pf-X' as string | null,
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
  },
  user: {
    id: 'u-1',
    email: 'alice@example.com',
    name: '爱丽丝',
    avatar: null as string | null,
    phone: null as string | null,
    bio: null as string | null,
    role: 'user' as 'user' | 'admin' | 'auditor',
    createdAt: '2026-01-01T00:00:00Z',
  },
}));

// ---------------------------------------------------------------------------
// mock：api 层（真实 composable 消费）
// ---------------------------------------------------------------------------

vi.mock('@/api/portfolio.api', async () => {
  const actual =
    await vi.importActual<typeof import('@/api/portfolio.api')>(
      '@/api/portfolio.api',
    );
  return {
    ...actual,
    listPortfolios: vi.fn(() => Promise.resolve(fx.portfolios)),
    clearPortfolioData: vi.fn(() => Promise.resolve(null)),
  };
});

vi.mock('@/api/auth.api', async () => {
  const actual =
    await vi.importActual<typeof import('@/api/auth.api')>('@/api/auth.api');
  return {
    ...actual,
    deleteAccount: vi.fn(() => Promise.resolve(null)),
  };
});

vi.mock('@/api/preference.api', async () => {
  const actual =
    await vi.importActual<typeof import('@/api/preference.api')>(
      '@/api/preference.api',
    );
  return {
    ...actual,
    getPreferences: vi.fn(() => Promise.resolve({ ...fx.prefs })),
    updatePreferences: vi.fn(() => Promise.resolve({ ...fx.prefs })),
  };
});

vi.mock('@/composables/use-toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));

// ---------------------------------------------------------------------------
// mock：reka-ui Select 原生替身（危险操作区不与其交互，仅保证 jsdom 挂载稳健）
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
// mock：与本用例无关的对话框 / 数据管理组件
// ---------------------------------------------------------------------------

function stub(name: string) {
  return defineComponent({
    name,
    setup() {
      return () => null;
    },
  });
}

vi.mock('@/modules/account/components/ChangeEmailDialog.vue', () => ({
  default: stub('ChangeEmailDialogStub'),
}));
vi.mock('@/modules/account/components/ChangePasswordDialog.vue', () => ({
  default: stub('ChangePasswordDialogStub'),
}));
vi.mock('@/modules/account/components/EditProfileDialog.vue', () => ({
  default: stub('EditProfileDialogStub'),
}));
vi.mock('@/modules/data-transfer/components/ExportPanel.vue', () => ({
  default: stub('ExportPanelStub'),
}));
vi.mock('@/modules/data-transfer/components/ImportDialog.vue', () => ({
  default: stub('ImportDialogStub'),
}));
vi.mock('@/modules/data-transfer/components/ImportTemplateButtons.vue', () => ({
  default: stub('ImportTemplateButtonsStub'),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

async function mountPage(): Promise<VueWrapper> {
  const authStore = useAuthStore();
  authStore.setUser({ ...fx.user });
  const portfolioStore = usePortfolioStore();

  const w = mount(SettingsPage, {
    attachTo: document.body,
    // 不可加 stubs: { teleport: true }——reka-ui Portal 内容会被 stub 吞掉
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
      // HelpTip 在生产由 main.ts 全局注册，测试环境未注册 → 以 stub 消除告警
      stubs: { HelpTip: true },
    },
  });
  await settle();
  portfolioStore.setCurrentPortfolio('pf-X');
  await settle();
  return w;
}

/** 在 document 范围内按文案定位按钮（弹窗经 Portal 渲染到 body） */
function buttonByText(text: string): HTMLButtonElement {
  const target = Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  );
  if (!target) throw new Error(`未找到文案为「${text}」的按钮`);
  return target;
}

/** 向 Portal 内的 input 写入值并触发 v-model 的 input 事件 */
async function fillInput(selector: string, value: string): Promise<void> {
  const el = document.querySelector(selector) as HTMLInputElement | null;
  if (!el) throw new Error(`未找到输入框 ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await nextTick();
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------

describe('SettingsPage 危险操作区（FE-SET-11/12）', () => {
  it('FE-SET-11 清空组合数据：名称不匹配禁用确认，精确匹配后才调 API', async () => {
    wrapper = await mountPage();

    buttonByText('清空数据').click();
    await settle();

    expect(document.body.textContent).toContain('确认清空该组合数据？');
    // 名称不匹配 → 确认按钮禁用
    await fillInput('#clear-data-confirm', '组合Y');
    expect(buttonByText('确认清空').disabled).toBe(true);
    // 错误名称下点击也不触发 API（disabled 元素 click 无副作用）
    buttonByText('确认清空').click();
    await settle();

    const { clearPortfolioData } = await import('@/api/portfolio.api');
    expect(clearPortfolioData).not.toHaveBeenCalled();

    // 精确匹配 → 解禁并落 API
    await fillInput('#clear-data-confirm', '组合X');
    expect(buttonByText('确认清空').disabled).toBe(false);
    buttonByText('确认清空').click();
    await settle();

    expect(clearPortfolioData).toHaveBeenCalledTimes(1);
    expect(clearPortfolioData).toHaveBeenCalledWith('pf-X');
  }, 15000);

  it('FE-SET-11 守卫边界：组合名称首尾空格按 trim 后比较', async () => {
    wrapper = await mountPage();

    buttonByText('清空数据').click();
    await settle();

    await fillInput('#clear-data-confirm', '  组合X  ');
    expect(buttonByText('确认清空').disabled).toBe(false);
  }, 15000);

  it('FE-SET-12 注销账户：邮箱不匹配禁用确认，精确匹配后才调 API', async () => {
    wrapper = await mountPage();

    buttonByText('注销账户').click();
    await settle();

    expect(document.body.textContent).toContain('确认注销账户？');
    // 邮箱不匹配 → 禁用
    await fillInput('#delete-account-email', 'bob@example.com');
    expect(buttonByText('确认注销').disabled).toBe(true);
    buttonByText('确认注销').click();
    await settle();

    const { deleteAccount } = await import('@/api/auth.api');
    expect(deleteAccount).not.toHaveBeenCalled();

    // 精确匹配 → 解禁并落 API
    await fillInput('#delete-account-email', 'alice@example.com');
    expect(buttonByText('确认注销').disabled).toBe(false);
    buttonByText('确认注销').click();
    await settle();

    expect(deleteAccount).toHaveBeenCalledTimes(1);
  }, 15000);

  it('注销确认文案为「自助恢复」口径（PRD §7.8 硬约束：不得出现联系客服）', async () => {
    wrapper = await mountPage();

    buttonByText('注销账户').click();
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('自助恢复');
    expect(text).not.toContain('联系客服');
  }, 15000);
});
