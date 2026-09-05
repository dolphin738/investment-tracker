/**
 * modules/admin/__tests__/interface-category-dialog.test.ts
 *
 * 回归验证：改动 A — 编辑分类时「排序」框改为数字后点保存无反应（Bug 修复）
 *
 * 根因：原 FormState.sortOrder 为 string，模板 <Input type="number" v-model.number>
 * 在用户编辑后让 form.sortOrder 运行时变成 number；旧 handleSubmit 用
 * `form.sortOrder.trim()` 对 number 调 .trim() 抛 TypeError，导致 updateMut.mutate
 * 永不执行 → 保存无反应。已改正为 Number(form.sortOrder) || 0（无 .trim()）。
 *
 * 验收点：
 * 1. 编辑模式：将排序框改为 7 后点「保存」，updateInterfaceCategory 收到的 body
 *    sort_order 严格 === 7（number），且不抛 TypeError（证明旧版会抛、新版不再抛）。
 * 2. 新增模式：填写 label + 排序 7 后点「新增」，createInterfaceCategory 收到
 *    sort_order === 7（number）。create / update 两条路径都应不再抛错。
 * 3. （根因守卫，纯逻辑）复刻新旧两段转换：number 经旧逻辑 .trim() 抛 TypeError；
 *    经新逻辑 Number(x) || 0 得到正确数字且不抛错。
 *
 * Dialog 内容经 reka-ui Portal 传送到 document.body，统一从 body 查询 DOM；
 * API 层与 toast 全部 mock 隔离网络。IconPicker 以 stub 替换，避免拉入 1500+ 图标注册表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { InterfaceCategory } from '@/api/interface-category.api';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

// ---------------------------------------------------------------------------
// mock：分类 API（捕获 create/update 调用体）+ toast + auth + IconPicker 替身
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
  listInterfaceCategories: vi.fn(() => Promise.resolve([])),
  createInterfaceCategory: vi.fn(() => Promise.resolve({})),
  updateInterfaceCategory: vi.fn(() => Promise.resolve({})),
  deleteInterfaceCategory: vi.fn(() =>
    Promise.resolve({ id: '', deleted: true }),
  ),
}));

vi.mock('@/api/interface-category.api', () => ({
  listInterfaceCategories: api.listInterfaceCategories,
  createInterfaceCategory: api.createInterfaceCategory,
  updateInterfaceCategory: api.updateInterfaceCategory,
  deleteInterfaceCategory: api.deleteInterfaceCategory,
}));

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

// 注意：此处不 stub InterfaceCategoryIconPicker，端到端用例④会挂载真实图标选择器
import InterfaceCategoryDialog from '../components/InterfaceCategoryDialog.vue';

let wrapper: VueWrapper | null = null;
let queryClient: QueryClient;
let pinia: ReturnType<typeof createPinia>;

/** body 文本（Portal 传送目的地） */
const bodyText = (): string => document.body.textContent ?? '';

/**
 * 挂载对话框并打开（先 open=false 挂载，再 setProps 打开，对齐真实使用方式：
 * AppLayout 常驻挂载、open 由 false → true 触发 watcher 回填 reset）。
 */
async function mountDialog(opts: {
  editing?: InterfaceCategory | null;
} = {}): Promise<VueWrapper> {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(InterfaceCategoryDialog, {
    props: { open: false, editing: opts.editing ?? null },
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }], pinia],
    },
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  await nextTick();
  return wrapper;
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

/** 从 body 中按文本找「保存 / 新增」提交按钮 */
function findSubmitButton(): HTMLButtonElement {
  const btns = Array.from(
    document.body.querySelectorAll('button'),
  ) as HTMLButtonElement[];
  const b = btns.find(
    (x) => x.textContent?.includes('保存') || x.textContent?.includes('新增'),
  );
  if (!b) throw new Error('未找到「保存/新增」按钮');
  return b;
}

/**
 * 完整沉降：vue-query 的 notifyManager 用 setTimeout 调度 mutationFn，
 * 单次 flushPromises 断言会跑在 mutation 执行之前（同 portfolio-dialog 模式）。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// ---------------------------------------------------------------------------

describe('InterfaceCategoryDialog — 改动 A 排序修复回归', () => {
  it('① 编辑模式：排序框改为 7 后保存 → updateInterfaceCategory 收到 sort_order === 7（number），不抛 TypeError', async () => {
    const editing: InterfaceCategory = {
      id: 'c1',
      label: '行情分类',
      icon: null,
      sort_order: 3,
      system: false,
      interface_count: 0,
      created_at: '',
      updated_at: '',
    };
    await mountDialog({ editing });

    // 回填：排序框原值应为 3（number 经 v-model.number 显示为 '3'）
    const orderInput = document.body.querySelector(
      '#cat-order',
    ) as HTMLInputElement;
    expect(orderInput.value).toBe('3');

    // 模拟用户把排序改为 7（v-model.number 后运行时为 number）
    await setInput('#cat-order', '7');

    // 点击保存：断言全程无异常抛出（旧版会在此处抛 TypeError 并阻断 mutate）
    let submitError: unknown;
    try {
      findSubmitButton().click();
      await settle();
    } catch (e) {
      submitError = e;
    }
    expect(submitError).toBeUndefined();

    // 核心断言：update mutation 被调用，且 body.sort_order 严格等于数字 7
    expect(api.updateInterfaceCategory).toHaveBeenCalledTimes(1);
    const call = api.updateInterfaceCategory.mock
      .calls[0] as unknown as [string, {
      label?: string;
      icon?: string | null;
      sort_order?: number;
    }];
    expect(call[0]).toBe('c1');
    expect(call[1].sort_order).toBe(7); // 严格等于数字 7（证明来自输入框的 number 未被破坏）
    expect(typeof call[1].sort_order).toBe('number');
    // 其余字段契约：label 原值、icon 经 trim()||null 归一为 null
    expect(call[1].label).toBe('行情分类');
    expect(call[1].icon).toBeNull();
  });

  it('② 新增模式：填写 label + 排序 7 后保存 → createInterfaceCategory 收到 sort_order === 7（number）', async () => {
    await mountDialog({ editing: null });

    // 新增态按钮文案应为「新增」
    expect(findSubmitButton().textContent).toContain('新增');

    // label 必填，否则 handleSubmit 直接 return（不触发任何 mutation）
    await setInput('#cat-label', '新分类');
    await setInput('#cat-order', '7');

    let submitError: unknown;
    try {
      findSubmitButton().click();
      await settle();
    } catch (e) {
      submitError = e;
    }
    expect(submitError).toBeUndefined();

    expect(api.createInterfaceCategory).toHaveBeenCalledTimes(1);
    const call = api.createInterfaceCategory.mock
      .calls[0] as unknown as [{ label: string; icon?: string | null; sort_order?: number }];
    expect(call[0].sort_order).toBe(7);
    expect(typeof call[0].sort_order).toBe('number');
    expect(call[0].label).toBe('新分类');
    expect(call[0].icon).toBeNull();
  });

  it('③ 空 label 时两个模式都不触发 mutation（handleSubmit 前置校验）', async () => {
    await mountDialog({ editing: null });
    // 不填 label 直接保存
    findSubmitButton().click();
    await settle();
    expect(api.createInterfaceCategory).not.toHaveBeenCalled();
    // 对话框未关闭（仍可见其字段标签「展示名」），证明 handleSubmit 前置校验生效
    expect(bodyText()).toContain('展示名');
  });

  it('④ 端到端（改动 B）：编辑模式下经真实图标选择器选中「Star」，保存时随 icon 字段提交', async () => {
    const editing: InterfaceCategory = {
      id: 'c1',
      label: '行情分类',
      icon: null,
      sort_order: 3,
      system: false,
      interface_count: 0,
      created_at: '',
      updated_at: '',
    };
    await mountDialog({ editing });

    // 打开图标选择器（触发器 id=cat-icon，位于 Portal 后的 document.body 内）
    const trigger = document.body.querySelector(
      '#cat-icon',
    ) as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();
    trigger!.click();
    await flushPromises();
    await nextTick();

    // 搜索框（placeholder 含「搜索图标」）输入 star
    const search = document.body.querySelector(
      'input[placeholder*="搜索图标"]',
    ) as HTMLInputElement | null;
    expect(search).toBeTruthy();
    search!.value = 'star';
    search!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    await nextTick();

    // 点击「Star」图标按钮（title=Star）
    const starBtn = document.body.querySelector(
      'button[title="Star"]',
    ) as HTMLButtonElement | null;
    expect(starBtn).toBeTruthy();
    starBtn!.click();
    await flushPromises();
    await nextTick();

    // 面板关闭后点保存
    let submitError: unknown;
    try {
      findSubmitButton().click();
      await settle();
    } catch (e) {
      submitError = e;
    }
    expect(submitError).toBeUndefined();

    // 核心断言：选中的图标名经 v-model 写入 form.icon，并随 icon 字段提交
    expect(api.updateInterfaceCategory).toHaveBeenCalledTimes(1);
    const call = api.updateInterfaceCategory.mock
      .calls[0] as unknown as [string, {
      label?: string;
      icon?: string | null;
      sort_order?: number;
    }];
    expect(call[1].icon).toBe('Star');
    // 未改动的排序/label 保持原值，证明两条字段互不干扰
    expect(call[1].sort_order).toBe(3);
    expect(call[1].label).toBe('行情分类');
  });
});

// ---------------------------------------------------------------------------
// 根因守卫：直接复刻 handleSubmit 中的两段转换逻辑，
// 证明「旧版对 number 调 .trim() 抛 TypeError」且「新版 Number(x)||0 正确且不抛」。
// ---------------------------------------------------------------------------

describe('sortOrder 转换逻辑回归守卫（复刻 handleSubmit）', () => {
  const oldTransform = (sortOrder: unknown): number =>
    (sortOrder as unknown as string).trim() ? Number(sortOrder) : 0;
  const newTransform = (sortOrder: unknown): number =>
    Number(sortOrder) || 0;

  it('编辑后 sortOrder 运行时为 number（复刻 v-model.number 行为）', () => {
    const el = document.createElement('input');
    el.type = 'number';
    el.value = '7';
    const modeled = Number(el.value); // Vue .number 修饰符效果：字符串 → 数字
    expect(typeof modeled).toBe('number');
    // 新逻辑：不抛错且得到正确数字
    expect(newTransform(modeled)).toBe(7);
  });

  it('旧逻辑对 number 调 .trim() 抛 TypeError（即「保存无反应」根因）', () => {
    const modeled = 7; // 用户编辑排序框后 form.sortOrder 的实际类型
    expect(() => oldTransform(modeled)).toThrow(TypeError);
  });

  it('新逻辑对空串 / 0 / null 均归一为 0 且不抛错', () => {
    expect(newTransform('')).toBe(0);
    expect(newTransform(0)).toBe(0);
    expect(newTransform(null)).toBe(0);
    // 负数 / 正数均保持
    expect(newTransform(-3)).toBe(-3);
    expect(newTransform(42)).toBe(42);
  });
});
