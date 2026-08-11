/**
 * hooks/__tests__/use-system-config.test.tsx — useSystemConfig 的 enabled 门控验收
 *
 * 验收点：
 * 1. 非管理员：enabled=false → 根本不发起 getSystemConfig 请求；
 * 2. 管理员：enabled=true → 发起 getSystemConfig(key) 请求；
 * 3. useUpdateSystemConfig：mutate(value) 调用 updateSystemConfig(key, value)。
 *
 * Mock 策略（稳健模式）：
 * - @/stores/auth.store：useIsAdmin 由模块级 adminFlag 控制；
 * - @/api/admin.api：通过 importOriginal + 内部 vi.fn() 覆盖 getSystemConfig /
 *   updateSystemConfig，断言统一走 vi.mocked(...)，避免模块级 vi.fn 变量在
 *   全量测试下的「闭包脱离」问题；
 * - sonner：toast 置空实现。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// 模块级开关：控制 useIsAdmin 的返回值（在测试间切换）
let adminFlag = false;

// 必须用 importOriginal + 内部 vi.fn() 覆盖，断言走 vi.mocked，
// 避免引用模块级 vi.fn 变量在 vitest 全量运行时的闭包脱离问题。
vi.mock('@/stores/auth.store', () => ({
  useIsAdmin: () => adminFlag,
}));

vi.mock('@/api/admin.api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    getSystemConfig: vi.fn(),
    updateSystemConfig: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { getSystemConfig, updateSystemConfig } from '@/api/admin.api';
import { useSystemConfig, useUpdateSystemConfig } from '@/hooks/use-system-config';

const KEY = 'securities_quote_api_base_url';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useSystemConfig — 非管理员不发起请求', () => {
  beforeEach(() => {
    adminFlag = false;
    const sample = {
      key: KEY,
      value: { url: '' },
      description: null,
      updatedAt: null,
    };
    vi.mocked(getSystemConfig).mockResolvedValue(sample);
    vi.mocked(updateSystemConfig).mockResolvedValue(sample);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('① 非管理员：enabled=false，不调用 getSystemConfig', () => {
    adminFlag = false;
    renderHook(() => useSystemConfig(KEY), { wrapper });
    // enabled:false 时查询不会执行，渲染同步完成即可断言。
    expect(vi.mocked(getSystemConfig)).not.toHaveBeenCalled();
  });

  it('② 管理员：enabled=true，调用 getSystemConfig(key)', async () => {
    adminFlag = true;
    renderHook(() => useSystemConfig(KEY), { wrapper });
    await waitFor(() => {
      expect(vi.mocked(getSystemConfig)).toHaveBeenCalledWith(KEY);
    });
  });

  it('③ useUpdateSystemConfig：mutateAsync(value) 调用 updateSystemConfig(key, value)', async () => {
    const { result } = renderHook(() => useUpdateSystemConfig(KEY), { wrapper });
    // 用 mutateAsync + await act 让 mutationFn 必然执行完再断言，去除 waitFor 竞态。
    await act(async () => {
      await result.current.mutateAsync({ url: 'https://x.example.com/api' });
    });
    expect(vi.mocked(updateSystemConfig)).toHaveBeenCalledWith(KEY, {
      url: 'https://x.example.com/api',
    });
  });
});
