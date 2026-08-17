/**
 * api/security-master.api.test.ts — deleteSecurityMasters 请求体序列化
 *
 * 回归：全选删除（all=true）必须把 camelCase 的 assetClass 转为 snake_case 的
 * asset_class 再发出；否则后端 SecurityMasterDeleteBody.asset_class 解析为 None，
 * all 模式退化为「删除全部孤儿主数据」（跨类别），误删非目标类别（#bug）。
 * 与 listSecurityMasters（已手动转换 asset_class）保持一致。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  http: { delete: vi.fn() },
}));

import { http } from '@/lib/api-client';
import { deleteSecurityMasters } from './security-master.api';

const mockedDelete = vi.mocked(http.delete);

describe('deleteSecurityMasters — 请求体序列化', () => {
  beforeEach(() => {
    mockedDelete.mockReset();
    mockedDelete.mockResolvedValue({ deleted: 0, skipped: [] });
  });

  it('全选删除（all=true + assetClass=STOCK）发出 asset_class 而非 assetClass', async () => {
    await deleteSecurityMasters({ all: true, assetClass: 'STOCK', q: '', exchange: null });

    const body = mockedDelete.mock.calls[0]?.[1]?.data as Record<string, unknown> | undefined;
    expect(body).toBeDefined();
    expect(body?.asset_class).toBe('STOCK');
    expect(body).not.toHaveProperty('assetClass');
    expect(body?.all).toBe(true);
  });

  it('单行删除仅发 ids（不携带资产类别字段）', async () => {
    await deleteSecurityMasters({ ids: ['id1'] });
    const body = mockedDelete.mock.calls[0]?.[1]?.data as Record<string, unknown> | undefined;
    expect(body?.ids).toEqual(['id1']);
    expect(body).not.toHaveProperty('asset_class');
    expect(body?.all).toBeUndefined();
  });

  it('无类别筛选的全选删除不带 asset_class（删全部孤儿，符合预期）', async () => {
    await deleteSecurityMasters({ all: true, assetClass: null, exchange: null });
    const body = mockedDelete.mock.calls[0]?.[1]?.data as Record<string, unknown> | undefined;
    expect(body?.all).toBe(true);
    expect(body).not.toHaveProperty('asset_class');
  });
});
