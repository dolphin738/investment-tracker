/**
 * modules/account/__tests__/change-email-dialog.test.ts — 修改邮箱对话框测试
 *
 * 覆盖：渲染回显 / 空与非法邮箱校验 / 与当前邮箱相同拦截 / 提交成功关闭。
 * API 层与 toast 全部 mock，Dialog 经 reka-ui Portal 渲染到 document.body。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import ChangeEmailDialog from '../components/ChangeEmailDialog.vue';
import { useAuthStore } from '@/stores/auth.store';
import { updateEmail } from '@/api/auth.api';
import type { UserPublic } from '@/lib/types';

// ---------------------------------------------------------------------------
// mock：修改邮箱 API + toast
// ---------------------------------------------------------------------------

const apiMocks = vi.hoisted(() => ({ updateEmail: vi.fn() }));

vi.mock('@/api/auth.api', () => ({
  updateEmail: apiMocks.updateEmail,
  register: vi.fn(),
  login: vi.fn(),
  getProfile: vi.fn(),
  updatePassword: vi.fn(),
  updateProfile: vi.fn(),
  deleteAccount: vi.fn(),
  restoreAccount: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/** jsdom 缺失的浏览器 API 兜底（reka-ui Dialog 需要） */
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

/** 用户夹具（avatar 可空、createdAt 必填，与 UserPublic 契约一致） */
const USER = {
  id: 'u1',
  email: 'old@example.com',
  name: '张三',
  phone: '13800138000',
  avatar: null,
  bio: null,
  role: 'user',
  createdAt: '2024-01-01T00:00:00Z',
} as unknown as UserPublic;

const bodyText = (): string => document.body.textContent ?? '';

let wrapper: VueWrapper | null = null;
let queryClient: QueryClient;
let pinia: Pinia;

/** 挂载并打开对话框，同时向 auth store 注入当前用户 */
async function mountDialog() {
  pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().setUser(USER);

  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(ChangeEmailDialog, {
    props: { open: false },
    attachTo: document.body,
    global: { plugins: [[VueQueryPlugin, { queryClient }], pinia] },
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

async function setInput(selector: string, value: string): Promise<void> {
  const el = document.body.querySelector(selector) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

async function submitForm(): Promise<void> {
  const form = document.body.querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  // vee-validate 异步校验 + Vue 响应式重渲染 + vue-query 的 mutation 链需要多个
  // 事件循环才能落地；用真实定时器留足时间，避免并行的测试文件抢占 CPU 造成竞态。
  await new Promise((resolve) => setTimeout(resolve, 30));
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await flushPromises();
}

beforeEach(() => {
  installJsdomPolyfills();
  apiMocks.updateEmail.mockReset().mockResolvedValue({
    accessToken: 't',
    user: { ...USER, email: 'new@example.com' },
  });
});

afterEach(async () => {
  // reka-ui 的 DialogPortal 会把内容传送到 body，并带退出动画；直接 unmount 会留下
  // 半销毁的传送节点，污染相邻用例。先关闭再卸载，等全部落地后清理。
  if (wrapper) {
    await wrapper.setProps({ open: false });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    wrapper.unmount();
    wrapper = null;
  }
  document.body.innerHTML = '';
});

describe('ChangeEmailDialog — 修改邮箱对话框', () => {
  it('渲染：标题「修改邮箱」、当前邮箱只读且回显 user.email', async () => {
    await mountDialog();

    expect(bodyText()).toContain('修改邮箱');
    const current = document.body.querySelector(
      '#current-email',
    ) as HTMLInputElement;
    expect(current.value).toBe('old@example.com');
    expect(current.disabled).toBe(true);
  });

  it('校验：空新邮箱提交显示「请输入新邮箱」且不发请求', async () => {
    await mountDialog();
    await submitForm();

    expect(bodyText()).toContain('请输入新邮箱');
    expect(updateEmail).not.toHaveBeenCalled();
  });

  it('校验：非法邮箱显示「请输入有效的邮箱」', async () => {
    await mountDialog();
    await setInput('#new-email', 'not-an-email');
    await submitForm();

    expect(bodyText()).toContain('请输入有效的邮箱');
    expect(updateEmail).not.toHaveBeenCalled();
  });

  it('拦相同：新邮箱与当前邮箱相同提示且不发请求', async () => {
    await mountDialog();
    await setInput('#new-email', 'old@example.com');
    await setInput('#email-current-password', 'secret');
    await submitForm();

    expect(bodyText()).toContain('新邮箱与当前邮箱相同');
    expect(updateEmail).not.toHaveBeenCalled();
  });

  it('提交成功：携带当前密码与新邮箱调用 updateEmail 并关闭对话框', async () => {
    const w = await mountDialog();
    await setInput('#new-email', 'new@example.com');
    await setInput('#email-current-password', 'secret');
    await submitForm();

    expect(updateEmail).toHaveBeenCalledTimes(1);
    expect(updateEmail).toHaveBeenCalledWith({
      currentPassword: 'secret',
      newEmail: 'new@example.com',
    });
    expect(w.emitted('openChange')?.at(-1)).toEqual([false]);
  });
});