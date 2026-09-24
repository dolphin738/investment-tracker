/**
 * api/__tests__/dividend-yield.api.test.ts — 路径契约测试（P0-1 + S15）
 *
 * 两件事：
 * 1. 曲线/反推价格路由段序为 /{masterId}/curve、/{masterId}/implied-price（与后端 router.py
 *    一致）——曾写反为 /curve/{masterId} 导致必 404，故 mock http 层断言实际拼出的 URL。
 * 2. **S15：后端新增的 9 个端点（pending 七端点 + seed 进度/取消）此前无任何路径断言**，
 *    本次补齐：URL 逐字断言（段序回归即拦）；批量端点另断言请求体是 `{items}` / `{ids}`
 *    包装（后端 Pydantic `extra="forbid"`，包装写错会直接 422）。
 */
import type { PendingAssignItemPayload } from '../dividend-yield.api';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({
  get: [] as { url: string; config?: unknown }[],
  post: [] as { url: string; body?: unknown }[],
}));

vi.mock('@/lib/api-client', () => ({
  http: {
    get: vi.fn(async (url: string, config?: unknown) => {
      calls.get.push({ url, config });
      return {};
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      calls.post.push({ url, body });
      return {};
    }),
    put: vi.fn(async () => ({})),
  },
}));

import {
  assignPendingDividend,
  batchAssignPendingDividends,
  batchIgnorePendingDividends,
  cancelSeedInitialDividends,
  getDividendYieldImpliedPrice,
  getPendingDividendSummary,
  getSeedProgress,
  ignorePendingDividend,
  listPendingDividends,
  reopenPendingDividend,
  seedInitialDividends,
} from '@/api/dividend-yield.api';

const pendingBase = '/dividend-yield/pending-dividends';

describe('dividend-yield api 路径契约（P0-1 + S15）', () => {
  beforeEach(() => {
    calls.get.length = 0;
    calls.post.length = 0;
  });

  it('implied-price 段序：/{masterId}/implied-price（id 在前）', async () => {
    await getDividendYieldImpliedPrice('m-1', 0.04);
    expect(calls.get[0].url).toBe('/dividend-yield/m-1/implied-price');
    expect(calls.get[0].config).toEqual({ params: { target_ratio: 0.04 } });
  });

  it('pending 读端点：列表（带筛选参数）与概览', async () => {
    await listPendingDividends({
      status: 'PENDING',
      q: '茅台',
      page: 2,
      pageSize: 20,
    });
    expect(calls.get[0].url).toBe(pendingBase);
    expect(calls.get[0].config).toEqual({
      params: { status: 'PENDING', q: '茅台', page: 2, pageSize: 20 },
    });

    await getPendingDividendSummary();
    expect(calls.get[1].url).toBe(`${pendingBase}/summary`);
  });

  it('pending 写端点：assign / ignore / reopen 段序为 /{id}/<动作>', async () => {
    await assignPendingDividend('p1', {
      reportYear: 2024,
      reportQuarter: 4,
      periodType: 'ANNUAL',
    });
    expect(calls.post[0].url).toBe(`${pendingBase}/p1/assign`);
    expect(calls.post[0].body).toEqual({
      reportYear: 2024,
      reportQuarter: 4,
      periodType: 'ANNUAL',
    });

    await ignorePendingDividend('p2');
    expect(calls.post[1].url).toBe(`${pendingBase}/p2/ignore`);

    await reopenPendingDividend('p3');
    expect(calls.post[2].url).toBe(`${pendingBase}/p3/reopen`);
  });

  it('pending 批量端点：静态段先于 {id}，请求体为 {items} / {ids} 包装', async () => {
    // §5.2b 续批：periodType 已是生成枚举联合，裸 string 字面量不再可赋值
    const items: PendingAssignItemPayload[] = [
      { id: 'p1', reportYear: 2024, reportQuarter: 4, periodType: 'ANNUAL' },
    ];
    await batchAssignPendingDividends(items);
    expect(calls.post[0].url).toBe(`${pendingBase}/batch-assign`);
    expect(calls.post[0].body).toEqual({ items });

    await batchIgnorePendingDividends(['p1', 'p2']);
    expect(calls.post[1].url).toBe(`${pendingBase}/batch-ignore`);
    expect(calls.post[1].body).toEqual({ ids: ['p1', 'p2'] });
  });

  it('seed 端点：触发 / 进度 / 取消 三条静态路径', async () => {
    await seedInitialDividends();
    expect(calls.post[0].url).toBe('/dividend-yield/seed-initial-dividends');

    await getSeedProgress();
    expect(calls.get[0].url).toBe('/dividend-yield/seed-initial-dividends/progress');

    await cancelSeedInitialDividends();
    expect(calls.post[1].url).toBe('/dividend-yield/seed-initial-dividends/cancel');
  });
});
