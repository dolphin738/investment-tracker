/**
 * modules/auth/__tests__/register-form.test.ts — 注册表单组件测试（@vue/test-utils）
 *
 * 按 §6.2 验收标准覆盖：渲染、各字段校验错误（邮箱 / 名称长度 / 密码强度 /
 * 确认密码一致）、提交成功（含名称可选语义）与提交失败。
 *
 * API 层与 toast 全部 mock，隔离网络与全局提示。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import RegisterForm from '../components/RegisterForm.vue';
import { register as registerApi } from '@/api/auth.api';
import { toast } from '@/composables/use-toast';
import { ApiError } from '@/lib/api-client';
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
  id: '2',
  email: 'new@example.com',
  name: null,
  role: 'user',
  createdAt: '2026-01-01T00:00:00Z',
};

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
  await router.push('/register');
  await router.isReady();
  const wrapper = mount(RegisterForm, {
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

interface FillOptions {
  email?: string;
  name?: string;
  password?: string;
  confirmPassword?: string;
}

/** 按需填写字段并提交表单 */
async function fillAndSubmit(
  wrapper: Awaited<ReturnType<typeof mountForm>>,
  options: FillOptions,
) {
  if (options.email !== undefined) {
    await wrapper.find('input#email').setValue(options.email);
  }
  if (options.name !== undefined) {
    await wrapper.find('input#name').setValue(options.name);
  }
  if (options.password !== undefined) {
    await wrapper.find('input#password').setValue(options.password);
  }
  if (options.confirmPassword !== undefined) {
    await wrapper.find('input#confirmPassword').setValue(options.confirmPassword);
  }
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

describe('RegisterForm — 注册表单', () => {
  it('渲染：卡片标题、描述、四个字段标签（含「名称（可选）」）与「返回登录」链接', async () => {
    const wrapper = await mountForm();
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).toContain('创建您的投资追踪账号');
    expect(wrapper.find('label[for="email"]').text()).toBe('邮箱');
    expect(wrapper.find('label[for="name"]').text()).toBe('名称（可选）');
    expect(wrapper.find('label[for="password"]').text()).toBe('密码');
    expect(wrapper.find('label[for="confirmPassword"]').text()).toBe('确认密码');
    expect(wrapper.text()).toContain('注册');
    expect(wrapper.text()).toContain('返回登录');
  });

  it('空表单提交：显示邮箱与密码错误，不发起注册请求', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {});
    expect(wrapper.text()).toContain('请输入有效的邮箱');
    expect(wrapper.text()).toContain('密码至少 8 位');
    expect(wrapper.findAll('p.text-destructive').length).toBeGreaterThanOrEqual(2);
    expect(registerApi).not.toHaveBeenCalled();
  });

  it('邮箱格式非法：显示「请输入有效的邮箱」', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'bad-email',
      password: 'abcd1234',
      confirmPassword: 'abcd1234',
    });
    expect(wrapper.text()).toContain('请输入有效的邮箱');
    expect(registerApi).not.toHaveBeenCalled();
  });

  it('名称超过 50 字：显示「名称最多 50 字」', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      name: '长'.repeat(51),
      password: 'abcd1234',
      confirmPassword: 'abcd1234',
    });
    expect(wrapper.text()).toContain('名称最多 50 字');
    expect(registerApi).not.toHaveBeenCalled();
  });

  it('密码不足 8 位：显示「密码至少 8 位」', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      password: 'abc123',
      confirmPassword: 'abc123',
    });
    expect(wrapper.text()).toContain('密码至少 8 位');
    expect(registerApi).not.toHaveBeenCalled();
  });

  it('密码缺少数字：显示「密码需同时包含字母和数字」', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      password: 'abcdefgh',
      confirmPassword: 'abcdefgh',
    });
    expect(wrapper.text()).toContain('密码需同时包含字母和数字');
    expect(registerApi).not.toHaveBeenCalled();
  });

  it('两次密码不一致：错误落在确认密码字段（refine path=confirmPassword）', async () => {
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      password: 'abcd1234',
      confirmPassword: 'abcd12345',
    });
    expect(wrapper.text()).toContain('两次输入的密码不一致');
    // 确认密码字段块内渲染错误，而密码字段块内无错误
    const confirmBlock = wrapper
      .findAll('div.space-y-2')
      .find((d) => d.find('label[for="confirmPassword"]').exists());
    expect(confirmBlock).toBeDefined();
    expect(confirmBlock!.find('p.text-destructive').text()).toBe('两次输入的密码不一致');
    expect(registerApi).not.toHaveBeenCalled();
  });

  it('提交成功（名称留空）：name 传 undefined、toast 提示并跳转登录页', async () => {
    vi.mocked(registerApi).mockResolvedValue(mockUser);
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      password: 'abcd1234',
      confirmPassword: 'abcd1234',
    });
    expect(registerApi).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'abcd1234',
      name: undefined,
    });
    expect(toast.success).toHaveBeenCalledWith('注册成功，请登录');
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('提交成功（名称填写）：name 原样上送', async () => {
    vi.mocked(registerApi).mockResolvedValue(mockUser);
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      name: '张三',
      password: 'abcd1234',
      confirmPassword: 'abcd1234',
    });
    expect(registerApi).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'abcd1234',
      name: '张三',
    });
  });

  it('提交失败（邮箱已注册）：停留在表单，错误交由拦截器 toast', async () => {
    vi.mocked(registerApi).mockRejectedValue(new ApiError(1002, '该邮箱已被注册'));
    const wrapper = await mountForm();
    await fillAndSubmit(wrapper, {
      email: 'new@example.com',
      password: 'abcd1234',
      confirmPassword: 'abcd1234',
    });
    expect(registerApi).toHaveBeenCalledTimes(1);
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).toContain('创建您的投资追踪账号');
    expect(router.currentRoute.value.path).toBe('/register');
  });
});
