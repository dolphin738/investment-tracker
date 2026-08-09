/**
 * api/transaction.api.test.ts — listTransactions 查询参数序列化（F2/F5 契约）
 *
 * F2（Part E-2）：`types` 数组必须以逗号分隔透传（types=BUY,SELL），
 * 空数组（= 全部）不发送；避免 axios 默认 `types[]=...` 序列化触发后端
 * forbidNonWhitelisted 400。F5：sortBy/sortOrder 原样透传。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  http: { get: vi.fn() },
}));

import { http } from '@/lib/api-client';
import { listTransactions } from './transaction.api';

const mockedGet = vi.mocked(http.get);

describe('listTransactions — 查询参数序列化', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedGet.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('多选 types 序列化为逗号分隔字符串', async () => {
    await listTransactions('pf-1', { types: ['BUY', 'SELL'], page: 1, pageSize: 20 });

    expect(mockedGet).toHaveBeenCalledWith('/portfolios/pf-1/cashflows', {
      params: expect.objectContaining({ types: 'BUY,SELL' }),
    });
  });

  it('空数组（全部）不发送 types 参数', async () => {
    await listTransactions('pf-1', { types: [], page: 1, pageSize: 20 });

    const params = mockedGet.mock.calls[0]?.[1]?.params as Record<string, unknown> | undefined;
    expect(params?.types).toBeUndefined();
  });

  it('sortBy/sortOrder 原样透传（F5）', async () => {
    await listTransactions('pf-1', { sortBy: 'amount', sortOrder: 'asc' });

    expect(mockedGet).toHaveBeenCalledWith('/portfolios/pf-1/cashflows', {
      params: expect.objectContaining({ sortBy: 'amount', sortOrder: 'asc' }),
    });
  });
});
