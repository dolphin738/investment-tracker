/**
 * modules/account/__tests__/change-password-dialog.test.ts — 修改密码对话框测试
 *
 * 覆盖：短密码/弱密码校验、两次输入不一致 refine、提交时剔除 confirmPassword（防 400）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import ChangePasswordDialog from '../components/ChangePasswordDialog.vue';
import { updatePassword } from '@/api/auth.api';
import type { UserPublic } from '@/lib/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

const apiMocks = vi.hoisted(() => ({ updatePassword: vi.fn() }));

vi.mock('@/api/auth.api', () => ({
  updatePassword: apiMocks.updatePassword,
  register: vi.fn(),
  login: vi.fn(),
  getProfile: vi.fn(),
  updateEmail: vi.fn(),
  updateProfile: vi.fn(),
  deleteAccount: vi.fn(),
  restoreAccount: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const USER = {
  id: 'u1',
  email: 'old@example.com',
  name: '张三',
  phone: null,
  avatar: null,
  bio: null,
  role: 'user',
  createdAt: '2024-01-01T00:00:00Z',
} as unknown as UserPublic;

const bodyText = (): string => document.body.textContent ?? '';

let wrapper: VueWrapper | null = null;
let queryClient: QueryClient;
let pinia: Pinia;

async function mountDialog() {
  pinia = createPinia();
  setActivePinia(pinia);
  await Promise.resolve();

  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(ChangePasswordDialog, {
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
  apiMocks.updatePassword.mockReset().mockResolvedValue({
    accessToken: 't',
    user: { ...USER, email: 'old@example.com' },
  });
});

afterEach(async () => {
  // reka-ui 的 DialogPortal 会把内容传送到 body，并带退出动画；直接 unmount 或强清
  // innerHTML 会留下半销毁的传送节点，污染相邻用例。先关闭再卸载，等全部落地后清理。
  if (wrapper) {
    await wrapper.setProps({ open: false });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    wrapper.unmount();
    wrapper = null;
  }
  document.body.innerHTML = '';
});

describe('ChangePasswordDialog — 修改密码对话框', () => {
  it('渲染：标题「修改密码」', async () => {
    await mountDialog();
    expect(bodyText()).toContain('修改密码');
  });

  it('校验：新密码不足 8 位显示「密码至少 8 位」且不发请求', async () => {
    await mountDialog();
    await setInput('#pwd-current', 'oldpass');
    await setInput('#pwd-new', 'Abc123');
    await setInput('#pwd-confirm', 'Abc123');
    await submitForm();

    expect(bodyText()).toContain('密码至少 8 位');
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('refine：两次输入不一致显示「两次输入的密码不一致」', async () => {
    await mountDialog();
    await setInput('#pwd-current', 'oldpass');
    await setInput('#pwd-new', 'Abc123456');
    await setInput('#pwd-confirm', 'Abc654321');
    await submitForm();

    expect(bodyText()).toContain('两次输入的密码不一致');
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('字段剔除：提交成功后 updatePassword 不携带 confirmPassword', async () => {
    const w = await mountDialog();
    await setInput('#pwd-current', 'oldpass');
    await setInput('#pwd-new', 'Abc123456');
    await setInput('#pwd-confirm', 'Abc123456');
    await submitForm();

    expect(updatePassword).toHaveBeenCalledTimes(1);
    const payload = apiMocks.updatePassword.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.currentPassword).toBe('oldpass');
    expect(payload.newPassword).toBe('Abc123456');
    expect(payload).not.toHaveProperty('confirmPassword');
    expect(w.emitted('openChange')?.at(-1)).toEqual([false]);
  });
});