/**
 * api/__tests__/dividend-yield.api.test.ts — 路径契约测试（P0-1 守护）
 *
 * 曲线/反推价格路由段序为 /{masterId}/curve、/{masterId}/implied-price
 * （与后端 router.py 一致）。曾写反为 /curve/{masterId} 导致必 404——
 * mock http 层断言实际拼出的 URL，段序回归即拦。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const gets = vi.hoisted(() => ({ calls: [] as { url: string; config?: unknown }[] }));

vi.mock('@/lib/api-client', () => ({
  http: {
    get: vi.fn(async (url: string, config?: unknown) => {
      gets.calls.push({ url, config });
      return {};
    }),
    put: vi.fn(async () => ({})),
  },
}));

import {
  getDividendYieldCurve,
  getDividendYieldImpliedPrice,
} from '@/api/dividend-yield.api';

describe('dividend-yield api 路径契约（P0-1）', () => {
  beforeEach(() => {
    gets.calls.length = 0;
  });

  it('curve 段序：/{masterId}/curve（id 在前）', async () => {
    await getDividendYieldCurve('m-1', 365);
    expect(gets.calls[0].url).toBe('/dividend-yield/m-1/curve');
    expect(gets.calls[0].config).toEqual({ params: { days: 365 } });
  });

  it('implied-price 段序：/{masterId}/implied-price（id 在前）', async () => {
    await getDividendYieldImpliedPrice('m-1', 0.04);
    expect(gets.calls[0].url).toBe('/dividend-yield/m-1/implied-price');
    expect(gets.calls[0].config).toEqual({ params: { target_ratio: 0.04 } });
  });
});
