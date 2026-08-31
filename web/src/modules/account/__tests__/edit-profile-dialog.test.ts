/**
 * modules/account/__tests__/edit-profile-dialog.test.ts — 编辑个人资料对话框测试
 *
 * 覆盖：头像非类型/超大小仅提示不发请求、未填字段归一为 '' 、简介计数 n/200。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import EditProfileDialog from '../components/EditProfileDialog.vue';
import { updateProfile } from '@/api/auth.api';
import { uploadAvatar } from '@/api/upload.api';
import { useAuthStore } from '@/stores/auth.store';
import type { UserPublic } from '@/lib/types';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

const apiMocks = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({
  updateProfile: apiMocks.updateProfile,
  register: vi.fn(),
  login: vi.fn(),
  getProfile: vi.fn(),
  updateEmail: vi.fn(),
  updatePassword: vi.fn(),
  deleteAccount: vi.fn(),
  restoreAccount: vi.fn(),
}));

vi.mock('@/api/upload.api', () => ({
  uploadAvatar: apiMocks.uploadAvatar,
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const USER = {
  id: 'u1',
  email: 'old@example.com',
  name: '张三',
  phone: '13800138000',
  avatar: null,
  bio: '价值投资',
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
  useAuthStore().setUser(USER);

  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  wrapper = mount(EditProfileDialog, {
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

async function dispatchFile(
  selector: string,
  file: File,
): Promise<void> {
  const el = document.body.querySelector(selector) as HTMLInputElement;
  Object.defineProperty(el, 'files', { value: [file], configurable: true });
  el.dispatchEvent(new Event('change', { bubbles: true }));
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
  apiMocks.updateProfile.mockReset().mockResolvedValue(USER);
  apiMocks.uploadAvatar.mockReset().mockResolvedValue({
    url: '/api/uploads/a.png',
    user: USER,
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

describe('EditProfileDialog — 编辑个人资料对话框', () => {
  it('渲染：标题「编辑资料」并按 user 回填昵称', async () => {
    await mountDialog();

    expect(bodyText()).toContain('编辑资料');
    expect(
      (document.body.querySelector('#profile-name') as HTMLInputElement).value,
    ).toBe('张三');
  });

  it('头像非类型提示：非 JPG/PNG/WebP 文件仅 toast、不发上传请求', async () => {
    await mountDialog();
    const gif = new File(['x'], 'a.gif', { type: 'image/gif' });
    await dispatchFile(
      'input[type="file"]',
      gif,
    );

    expect(toast.error).toHaveBeenCalledWith('仅支持 JPG / PNG / WebP 格式的图片');
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('头像超大小提示：超过 2MB 文件仅 toast、不发上传请求', async () => {
    await mountDialog();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'a.png', {
      type: 'image/png',
    });
    await dispatchFile('input[type="file"]', big);

    expect(toast.error).toHaveBeenCalledWith('图片大小不能超过 2MB');
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('归一：清空昵称后提交，updateProfile 收到 name 为空字符串', async () => {
    const w = await mountDialog();
    // 清空初始回填的昵称
    await setInput('#profile-name', '');
    await submitForm();

    expect(updateProfile).toHaveBeenCalledTimes(1);
    const payload = apiMocks.updateProfile.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.name).toBe('');
    expect(typeof payload.avatar).toBe('string');
    expect(Object.keys(payload).sort()).toEqual(
      ['avatar', 'bio', 'name', 'phone'].sort(),
    );
    expect(w.emitted('openChange')?.at(-1)).toEqual([false]);
  });

  it('简介计数：输入后显示 n/200', async () => {
    await mountDialog();
    await setInput('#profile-bio', '看好中国股市');

    expect(bodyText()).toContain('6/200');
  });
});