/**
 * modules/auth/__tests__/login-form.test.ts — 登录表单组件测试（@vue/test-utils）
 *
 * 按 §6.2 验收标准覆盖：渲染、空态校验、提交成功 / 失败（1001）、
 * 1007 注销冷静期恢复引导（含 remainingDays 缺省回落 30 与恢复流程）。
 *
 * API 层与 toast 全部 mock，隔离网络与全局提示。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import LoginForm from '../components/LoginForm.vue';
import { login as loginApi, restoreAccount as restoreAccountApi } from '@/api/auth.api';
import { toast } from '@/composables/use-toast';
import { useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/lib/api-client';
import { AUTH_RETURN_KEY } from '@/lib/constants';
import type { UserPublic } from '@/api/types';

vi.mock('@/api/auth.api', () => ({
  login: vi.fn(),
  register: vi.fn(),
  getProfile: vi.fn(),
  updatePassword: vi.fn(),
  updateEmail: vi.fn(),
  updateProfile: vi.fn(),
  deleteAccount: vi.fn(),
  restoreAccount: vi.fn(),
}));

vi.mock('@/composables/use-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// api-client（ApiError 来源模块）顶层引用了 vue-sonner，一并 mock 防止副作用
vi.mock('vue-sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: { name: 'Toaster', template: '<div />' },
}));

const mockUser: UserPublic = {
  id: '1',
  email: 'user@example.com',
  name: '测试用户',
  role: 'user',
  createdAt: '2026-01-01T00:00:00Z',
};

const loginResponse = { accessToken: 'token-1', user: mockUser };

let router: Router;
let pinia: Pinia;
let queryClient: QueryClient;

function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: { template: '<div>login-page</div>' } },
      { path: '/register', name: 'register', component: { template: '<div>register-page</div>' } },
      { path: '/', name: 'dashboard', component: { template: '<div>dashboard-page</div>' } },
      { path: '/holdings', name: 'holdings', component: { template: '<div>holdings-page</div>' } },
    ],
  });
}

/** 等待 mutation 微任务链 + tanstack query 批量通知 + vee-validate 校验管线全部落地 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flushPromises();
}

async function mountForm() {
  router = buildRouter();
  await router.push('/login');
  await router.isReady();
  const wrapper = mount(LoginForm, {
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

/** 填写邮箱 + 密码并提交 */
async function fillAndSubmit(wrapper: Awaited<ReturnType<typeof mountForm>>, email: string, password: string) {
  await wrapper.find('input#email').setValue(email);
  await wrapper.find('input#password').setValue(password);
  await wrapper.find('form').trigger('submit');
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  sessionStorage.clear();
  localStorage.clear();
});

describe('LoginForm — 登录表单', () => {
  it('渲染：卡片标题、描述、字段标签与「立即注册」链接', async () => {
    const wrapper = await mountForm();
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).toContain('输入您的邮箱与密码登录系统');
    expect(wrapper.find('label[for="email"]').text()).toBe('邮箱');
    expect(wrapper.find('label[for="password"]').text()).toBe('密码');
    expect(wrapper.find('input#email').attributes('type')).toBe('email');
    expect(wrapper.find('input#email').attributes('autocomplete')).toBe('email');
    expect(wrapper.find('input#password').attributes('autocomplete')).toBe('current-password');
    expect(wrapper.text()).toContain('登录');
    expect(wrapper.text()).toContain('立即注册');
  });

  it('空表单提交：行内显示校验错误（text-destructive），不发起登录请求', async () => {
    const wrapper = await mountForm();
    await wrapper.find('form').trigger('submit');
    await settle();
    expect(wrapper.text()).toContain('请输入有效的邮箱');
    expect(wrapper.text()).toContain('密码至少 6 位');
    const errorNodes = wrapper.findAll('p.text-destructive');
    expect(errorNodes.length).toBeGreaterThanOrEqual(2);
    expect(loginApi).not.toHaveBeenCalled();
  });

  it('邮箱格式非法：仅显示「请输入有效的邮箱」', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'not-an-email', '123456');
    expect(wrapper.text()).toContain('请输入有效的邮箱');
    expect(wrapper.text()).not.toContain('密码至少 6 位');
    expect(loginApi).not.toHaveBeenCalled();
  });

  it('密码不足 6 位：显示「密码至少 6 位」', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '12345');
    expect(wrapper.text()).toContain('密码至少 6 位');
    expect(loginApi).not.toHaveBeenCalled();
  });

  it('提交成功：写入 auth store、toast「登录成功」并跳转概览', async () => {
    vi.mocked(loginApi).mockResolvedValue(loginResponse);
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '123456');
    expect(loginApi).toHaveBeenCalledWith({ email: 'user@example.com', password: '123456' });
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('token-1');
    expect(toast.success).toHaveBeenCalledWith('登录成功');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('登录意图回跳：sessionStorage 记录的意图路由优先于默认首页', async () => {
    vi.mocked(loginApi).mockResolvedValue(loginResponse);
    sessionStorage.setItem(AUTH_RETURN_KEY, '/holdings');
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '123456');
    expect(router.currentRoute.value.path).toBe('/holdings');
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('1001 邮箱/密码错：停留在登录表单（toast 由拦截器统一处理）', async () => {
    vi.mocked(loginApi).mockRejectedValue(new ApiError(1001, '邮箱或密码错误'));
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', 'wrong-pass');
    expect(loginApi).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('输入您的邮箱与密码登录系统');
    expect(wrapper.text()).not.toContain('账户处于注销冷静期');
    expect(useAuthStore().isAuthenticated).toBe(false);
  });

  it('1007 注销冷静期：渲染恢复引导卡片，展示后端 remainingDays', async () => {
    vi.mocked(loginApi).mockRejectedValue(
      new ApiError(1007, '账户处于注销冷静期', { remainingDays: 7 }),
    );
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '123456');
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).toContain('账户处于注销冷静期');
    expect(wrapper.text()).toContain('7 天冷静期');
    expect(wrapper.text()).toContain('恢复账户');
    expect(wrapper.text()).toContain('暂不恢复');
  });

  it('1007 且 data 缺失：remainingDays 回落默认 30 天', async () => {
    vi.mocked(loginApi).mockRejectedValue(new ApiError(1007, '账户处于注销冷静期', null));
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '123456');
    expect(wrapper.text()).toContain('30 天冷静期');
  });

  it('1007 后点击「暂不恢复」：回到普通登录表单', async () => {
    vi.mocked(loginApi).mockRejectedValue(
      new ApiError(1007, '账户处于注销冷静期', { remainingDays: 7 }),
    );
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '123456');
    const dismissBtn = wrapper.findAll('button').find((b) => b.text() === '暂不恢复');
    expect(dismissBtn).toBeDefined();
    await dismissBtn!.trigger('click');
    await settle();
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).toContain('输入您的邮箱与密码登录系统');
  });

  it('1007 后点击「恢复账户」：凭已输入凭证调用恢复接口并进入登录态', async () => {
    vi.mocked(loginApi).mockRejectedValue(
      new ApiError(1007, '账户处于注销冷静期', { remainingDays: 3 }),
    );
    vi.mocked(restoreAccountApi).mockResolvedValue(loginResponse);
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, 'user@example.com', '123456');
    const restoreBtn = wrapper.findAll('button').find((b) => b.text() === '恢复账户');
    expect(restoreBtn).toBeDefined();
    await restoreBtn!.trigger('click');
    await settle();
    expect(restoreAccountApi).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: '123456',
    });
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('账户已恢复');
    expect(router.currentRoute.value.path).toBe('/');
  });
});
