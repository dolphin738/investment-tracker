/**
 * api/security-master.api.test.ts — 请求序列化 & sync 超时
 *
 * 回归 1：全选删除（all=true）必须把 camelCase 的 assetClass 转为 snake_case 的
 *   asset_class 再发出；否则后端 SecurityMasterDeleteBody.asset_class 解析为 None，
 *   all 模式退化为「删除全部孤儿主数据」（跨类别），误删非目标类别（#bug）。
 *   与 listSecurityMasters（已手动转换 asset_class）保持一致。
 *
 * 回归 2：手动同步必须用 per-call 180s timeout。
 *   实测 dev 库一次完整 sync（3 MASTER_LIST 接口 + 12k 行 upsert + 自愈去重）
 *   需 62s+；用 axios 实例默认 30s 会被 axios 提前 abort，但后端进程仍在跑且
 *   最终会 commit，前端却因「网络异常 + 同步失败」两条 toast 误判为失败
 *   （30s < 实际耗时，根因。修复见 syncSecurityMasters 的 timeout 选项）。
 *
 * 平移说明：React 版测试中的 assetClass: null / exchange: null 在本版
 * 类型（可选字段 string | undefined）下改为直接省略，语义一致（均不发送该字段）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  http: { delete: vi.fn(), post: vi.fn() },
}));

import { http } from '@/lib/api-client';
import { deleteSecurityMasters, syncSecurityMasters } from './security-master.api';

const mockedDelete = vi.mocked(http.delete);
const mockedPost = vi.mocked(http.post);

describe('deleteSecurityMasters — 请求体序列化', () => {
  beforeEach(() => {
    mockedDelete.mockReset();
    mockedDelete.mockResolvedValue({ deleted: 0, skipped: [] });
  });

  it('全选删除（all=true + assetClass=STOCK）发出 asset_class 而非 assetClass', async () => {
    await deleteSecurityMasters({ all: true, assetClass: 'STOCK', q: '' });

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
    await deleteSecurityMasters({ all: true });
    const body = mockedDelete.mock.calls[0]?.[1]?.data as Record<string, unknown> | undefined;
    expect(body?.all).toBe(true);
    expect(body).not.toHaveProperty('asset_class');
  });
});

describe('syncSecurityMasters — per-call 超时', () => {
  beforeEach(() => {
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ synced: 0, failed: 0, errors: [] });
  });

  it('必须以 per-call timeout=180000ms 调用，覆盖 axios 实例默认 30s', async () => {
    // 该常量是修复根因（30s 实例默认 < 62s 实测同步耗时）的关键约束：
    // 任何改动都要重新评估实测同步耗时，留 2~3× 余量。
    await syncSecurityMasters();

    const config = mockedPost.mock.calls[0]?.[2];
    expect(config).toBeDefined();
    expect(config?.timeout).toBe(180_000);
    expect(config?.timeout).toBeGreaterThan(30_000);
  });

  it('调用路径与 body 必须为 POST /admin/securities/sync（无 body）', async () => {
    await syncSecurityMasters();
    expect(mockedPost.mock.calls[0]?.[0]).toBe('/admin/securities/sync');
    expect(mockedPost.mock.calls[0]?.[1]).toBeUndefined();
  });
});
